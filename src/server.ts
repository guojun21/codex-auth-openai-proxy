import Fastify from "fastify";

import { ProxyApiKeyStore } from "./api-keys.js";
import type { AppConfig } from "./config.js";
import { fetchWithAuthRetry, resolveUpstreamAuth } from "./auth.js";
import { ProxyLogger, sanitizeForLog, sanitizeHeaders } from "./logging.js";
import {
  buildFallbackResponsesObject,
  buildUpstreamChatRequest,
  buildUpstreamResponsesRequest,
  parseUpstreamResponsePayload,
  toChatCompletionResponse,
  toChatCompletionUsage,
  toModelsResponse,
  type JsonMap,
} from "./openai.js";
import {
  collectSseFrames,
  formatSseData,
  iterateSseFrames,
  safeParseSseJson,
} from "./sse.js";

function extractRequestApiKey(requestHeaders: Record<string, unknown>): string | null {
  const xApiKey = requestHeaders["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim().length > 0) {
    return xApiKey.trim();
  }

  const authHeader = requestHeaders.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }

  return null;
}

async function ensureAuthorized(
  requestHeaders: Record<string, unknown>,
  apiKeyStore: ProxyApiKeyStore,
): Promise<void> {
  if (!apiKeyStore.isEnabled()) {
    return;
  }

  const token = extractRequestApiKey(requestHeaders);
  if (!token || !apiKeyStore.find(token)) {
    throw Object.assign(new Error("Unauthorized: missing or invalid API key"), {
      statusCode: 401,
    });
  }
  await apiKeyStore.markUsed(token);
}

function requestPath(url: string): string {
  try {
    return new URL(url, "http://127.0.0.1").pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function headerText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.join(" ");
  }
  return "";
}

function detectCursorRequest(
  requestHeaders: Record<string, unknown>,
): {
  isCursor: boolean;
  matchedBy: string[];
} {
  const checks: Array<[string, string]> = [
    ["user-agent", headerText(requestHeaders["user-agent"])],
    ["x-client-info", headerText(requestHeaders["x-client-info"])],
    ["x-requested-with", headerText(requestHeaders["x-requested-with"])],
    ["origin", headerText(requestHeaders.origin)],
    ["referer", headerText(requestHeaders.referer)],
    ["sec-ch-ua", headerText(requestHeaders["sec-ch-ua"])],
  ];

  const matchedBy = checks
    .filter(([, value]) => value.toLowerCase().includes("cursor"))
    .map(([name]) => name);

  return {
    isCursor: matchedBy.length > 0,
    matchedBy,
  };
}

function applyCursorGpt54Profile(
  requestBody: JsonMap,
  requestHeaders: Record<string, unknown>,
): {
  body: JsonMap;
  detected: boolean;
  applied: boolean;
  matchedBy: string[];
} {
  const detection = detectCursorRequest(requestHeaders);
  const requestedModel =
    typeof requestBody.model === "string" && requestBody.model.length > 0
      ? requestBody.model
      : null;

  if (!detection.isCursor || requestedModel !== "gpt-5.4") {
    return {
      body: requestBody,
      detected: detection.isCursor,
      applied: false,
      matchedBy: detection.matchedBy,
    };
  }

  return {
    body: {
      ...requestBody,
      service_tier: "priority",
      reasoning: {
        ...(requestBody.reasoning &&
        typeof requestBody.reasoning === "object"
          ? (requestBody.reasoning as JsonMap)
          : {}),
        effort: "xhigh",
        summary: "none",
      },
    },
    detected: true,
    applied: true,
    matchedBy: detection.matchedBy,
  };
}

function statusCodeFromError(error: unknown): number {
  return typeof (error as { statusCode?: unknown }).statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : 500;
}

function proxyErrorBody(error: unknown): JsonMap {
  return {
    error: {
      message: error instanceof Error ? error.message : "Unexpected error",
      type: "proxy_error",
    },
  };
}

function serializeError(error: unknown): JsonMap {
  const body = proxyErrorBody(error);
  return {
    status_code: statusCodeFromError(error),
    ...(body.error && typeof body.error === "object" ? (body.error as JsonMap) : body),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
}

async function relayUpstreamError(response: Response): Promise<{
  statusCode: number;
  body: JsonMap;
}> {
  const text = await response.text();
  try {
    return {
      statusCode: response.status,
      body: JSON.parse(text) as JsonMap,
    };
  } catch {
    return {
      statusCode: response.status,
      body: {
        error: {
          message: text || "Upstream request failed",
          type: "upstream_error",
        },
      },
    };
  }
}

async function postUpstreamResponses(
  config: AppConfig,
  body: JsonMap,
): Promise<Response> {
  return fetchWithAuthRetry(config, `${config.upstreamBaseUrl}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

async function fetchUpstreamModelsWithRetry(
  config: AppConfig,
  url: string,
  attempts = 3,
): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithAuthRetry(config, url, {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      });

      if (response.status < 500) {
        return response;
      }
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }

    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  if (lastResponse) {
    return lastResponse;
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to fetch upstream models");
}

export async function buildServer(config: AppConfig) {
  const app = Fastify({
    logger: true,
  });
  const proxyLogger = new ProxyLogger(config);
  const apiKeyStore = new ProxyApiKeyStore(
    config.proxyApiKeysStatePath,
    config.proxyApiKeys,
  );
  await proxyLogger.init();
  await apiKeyStore.init();

  let cachedModels:
    | {
        expiresAt: number;
        body: JsonMap;
      }
    | undefined;

  app.get("/health", async (request, reply) => {
    try {
      await ensureAuthorized(
        request.headers as Record<string, unknown>,
        apiKeyStore,
      );
      const auth = await resolveUpstreamAuth(config);
      return {
        ok: true,
        upstream_base_url: config.upstreamBaseUrl,
        auth_json_path: config.authJsonPath,
        account_id: auth.accountId,
        client_version: config.clientVersion,
        auth_enabled: apiKeyStore.isEnabled(),
        accepted_auth_headers: ["Authorization: Bearer <key>", "X-API-Key: <key>"],
        configured_api_key_count: apiKeyStore.count(),
        logging_enabled: proxyLogger.isEnabled(),
        model_aliases: config.modelAliases
          .filter((alias) => alias.expose !== false)
          .map((alias) => ({
            alias: alias.alias,
            upstream_model: alias.upstreamModel,
            reasoning_effort: alias.reasoningEffort ?? null,
            reasoning_summary: alias.reasoningSummary ?? null,
            service_tier: alias.serviceTier ?? null,
            context_window: alias.contextWindow ?? null,
          })),
      };
    } catch (error) {
      return reply.code(statusCodeFromError(error)).send(proxyErrorBody(error));
    }
  });

  app.get("/admin/logging", async (request, reply) => {
    try {
      await ensureAuthorized(request.headers as Record<string, unknown>, apiKeyStore);
      return proxyLogger.status();
    } catch (error) {
      return reply.code(statusCodeFromError(error)).send(proxyErrorBody(error));
    }
  });

  app.post("/admin/logging", async (request, reply) => {
    const startedAt = Date.now();
    const requestBody = (request.body ?? {}) as JsonMap;
    try {
      await ensureAuthorized(request.headers as Record<string, unknown>, apiKeyStore);
      if (typeof requestBody.enabled !== "boolean") {
        return reply.code(400).send({
          error: {
            message: "enabled must be a boolean",
            type: "invalid_request_error",
          },
        });
      }

      const status = await proxyLogger.setEnabled(requestBody.enabled);
      await proxyLogger.record(
        {
          kind: "control",
          action: "logging.set_enabled",
          enabled: requestBody.enabled,
          method: request.method,
          path: requestPath(request.url),
          statusCode: 200,
          durationMs: Date.now() - startedAt,
          request: {
            headers: sanitizeHeaders(request.headers as Record<string, unknown>),
            body: sanitizeForLog(requestBody) as JsonMap,
          },
          response: status,
        },
        { force: requestBody.enabled },
      );
      return status;
    } catch (error) {
      return reply.code(statusCodeFromError(error)).send(proxyErrorBody(error));
    }
  });

  app.get("/admin/logs", async (request, reply) => {
    try {
      await ensureAuthorized(request.headers as Record<string, unknown>, apiKeyStore);
      const query = (request.query ?? {}) as Record<string, unknown>;
      const rawLimit = query.limit;
      const limit =
        typeof rawLimit === "number"
          ? rawLimit
          : typeof rawLimit === "string"
            ? Number(rawLimit)
            : 100;
      return {
        ...proxyLogger.status(),
        entries: await proxyLogger.list(Number.isFinite(limit) ? limit : 100),
      };
    } catch (error) {
      return reply.code(statusCodeFromError(error)).send(proxyErrorBody(error));
    }
  });

  app.get("/admin/api-keys", async (request, reply) => {
    try {
      await ensureAuthorized(request.headers as Record<string, unknown>, apiKeyStore);
      return {
        auth_enabled: apiKeyStore.isEnabled(),
        configured_api_key_count: apiKeyStore.count(),
        keys: apiKeyStore.list(),
      };
    } catch (error) {
      return reply.code(statusCodeFromError(error)).send(proxyErrorBody(error));
    }
  });

  app.post("/admin/api-keys", async (request, reply) => {
    const requestBody = (request.body ?? {}) as JsonMap;
    try {
      await ensureAuthorized(request.headers as Record<string, unknown>, apiKeyStore);
      const label =
        typeof requestBody.label === "string" && requestBody.label.trim().length > 0
          ? requestBody.label.trim()
          : undefined;
      const created = await apiKeyStore.create(label);
      return {
        id: created.id,
        key: created.key,
        label: created.label,
        created_at: created.created_at,
        last_used_at: created.last_used_at,
      };
    } catch (error) {
      return reply.code(statusCodeFromError(error)).send(proxyErrorBody(error));
    }
  });

  app.get("/v1/models", async (request, reply) => {
    const startedAt = Date.now();
    const requestDetails = {
      headers: sanitizeHeaders(request.headers as Record<string, unknown>),
      query: {
        client_version: config.clientVersion,
      },
    };

    try {
      await ensureAuthorized(request.headers as Record<string, unknown>, apiKeyStore);
      const now = Date.now();
      if (cachedModels && cachedModels.expiresAt > now) {
        await proxyLogger.record({
          kind: "request",
          action: "models.list",
          method: request.method,
          path: requestPath(request.url),
          statusCode: 200,
          durationMs: Date.now() - startedAt,
          request: requestDetails,
          upstream: {
            endpoint: "models",
            cache: "hit",
          },
          response: {
            body: cachedModels.body,
          },
        });
        return cachedModels.body;
      }

      const url = new URL(`${config.upstreamBaseUrl}/models`);
      url.searchParams.set("client_version", config.clientVersion);
      const upstream = await fetchUpstreamModelsWithRetry(config, url.toString());

      if (!upstream.ok) {
        const relayed = await relayUpstreamError(upstream);
        await proxyLogger.record({
          kind: "request",
          action: "models.list",
          method: request.method,
          path: requestPath(request.url),
          statusCode: relayed.statusCode,
          durationMs: Date.now() - startedAt,
          request: requestDetails,
          upstream: {
            endpoint: "models",
            url: url.toString(),
            status: upstream.status,
            cache: "miss",
            response_body: relayed.body,
          },
          response: {
            body: relayed.body,
          },
        });
        return reply.code(relayed.statusCode).send(relayed.body);
      }

      const payload = (await upstream.json()) as JsonMap;
      const models = Array.isArray(payload.models)
        ? (payload.models.filter(
            (value): value is JsonMap => Boolean(value) && typeof value === "object",
          ) as JsonMap[])
        : [];
      const body = toModelsResponse(models, config);
      cachedModels = {
        expiresAt: now + 60_000,
        body,
      };

      await proxyLogger.record({
        kind: "request",
        action: "models.list",
        method: request.method,
        path: requestPath(request.url),
        statusCode: 200,
        durationMs: Date.now() - startedAt,
        request: requestDetails,
        upstream: {
          endpoint: "models",
          url: url.toString(),
          status: upstream.status,
          cache: "miss",
          response_body: payload,
        },
        response: {
          body,
        },
      });
      return body;
    } catch (error) {
      const statusCode = statusCodeFromError(error);
      const body = proxyErrorBody(error);
      await proxyLogger.record({
        kind: "request",
        action: "models.list",
        method: request.method,
        path: requestPath(request.url),
        statusCode,
        durationMs: Date.now() - startedAt,
        request: requestDetails,
        error: serializeError(error),
        response: {
          body,
        },
      });
      return reply.code(statusCode).send(body);
    }
  });

  app.post("/v1/responses", async (request, reply) => {
    const startedAt = Date.now();
    const rawRequestBody = (request.body ?? {}) as JsonMap;
    const cursorProfile = applyCursorGpt54Profile(
      rawRequestBody,
      request.headers as Record<string, unknown>,
    );
    const requestBody = cursorProfile.body;
    const routePath = requestPath(request.url);
    const requestDetails = {
      headers: sanitizeHeaders(request.headers as Record<string, unknown>),
      body: sanitizeForLog(requestBody),
      cursor_profile: {
        detected: cursorProfile.detected,
        applied: cursorProfile.applied,
        matched_by: cursorProfile.matchedBy,
      },
    };

    try {
      await ensureAuthorized(request.headers as Record<string, unknown>, apiKeyStore);
      const upstreamRequest = buildUpstreamResponsesRequest(requestBody, config);
      const streamRequested = Boolean(requestBody.stream);
      const upstream = await postUpstreamResponses(config, upstreamRequest.upstreamBody);
      const upstreamDetails: JsonMap = {
        endpoint: "responses",
        url: `${config.upstreamBaseUrl}/responses`,
        method: "POST",
        request_body: upstreamRequest.upstreamBody,
        alias_applied: upstreamRequest.aliasApplied,
        public_model: upstreamRequest.publicModel,
        cursor_profile_applied: cursorProfile.applied,
        cursor_profile_matched_by: cursorProfile.matchedBy,
        status: upstream.status,
      };

      if (!upstream.ok) {
        const relayed = await relayUpstreamError(upstream);
        upstreamDetails.response_body = relayed.body;
        await proxyLogger.record({
          kind: "request",
          action: streamRequested ? "responses.create.stream" : "responses.create",
          method: request.method,
          path: routePath,
          statusCode: relayed.statusCode,
          durationMs: Date.now() - startedAt,
          request: requestDetails as JsonMap,
          upstream: upstreamDetails,
          response: {
            body: relayed.body,
          },
        });
        return reply.code(relayed.statusCode).send(relayed.body);
      }

      if (!upstream.body) {
        const body = {
          error: {
            message: "Upstream response body was empty",
            type: "upstream_error",
          },
        };
        await proxyLogger.record({
          kind: "request",
          action: streamRequested ? "responses.create.stream" : "responses.create",
          method: request.method,
          path: routePath,
          statusCode: 502,
          durationMs: Date.now() - startedAt,
          request: requestDetails as JsonMap,
          upstream: upstreamDetails,
          response: {
            body,
          },
        });
        return reply.code(502).send(body);
      }

      if (streamRequested) {
        const captureEvents = proxyLogger.isEnabled() || upstreamRequest.aliasApplied;
        const loggedEvents: unknown[] = [];

        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        for await (const frame of iterateSseFrames(upstream.body)) {
          const event = safeParseSseJson(frame);
          if (captureEvents) {
            loggedEvents.push(event ?? { event: frame.event, data: frame.data, raw: frame.raw });
          }

          if (
            upstreamRequest.aliasApplied &&
            event?.response &&
            typeof event.response === "object"
          ) {
            (event.response as JsonMap).model = upstreamRequest.publicModel;
            reply.raw.write(formatSseData(event));
            continue;
          }

          reply.raw.write(`${frame.raw}\n\n`);
        }
        reply.raw.end();

        if (proxyLogger.isEnabled()) {
          upstreamDetails.sse_events = loggedEvents;
          await proxyLogger.record({
            kind: "request",
            action: "responses.create.stream",
            method: request.method,
            path: routePath,
            statusCode: 200,
            durationMs: Date.now() - startedAt,
            request: requestDetails as JsonMap,
            upstream: upstreamDetails,
            response: {
              stream: true,
              model: upstreamRequest.publicModel,
            },
          });
        }
        return reply;
      }

      const frames = await collectSseFrames(upstream.body);
      const events = frames.map(safeParseSseJson);
      const parsed = parseUpstreamResponsePayload(events);
      const completedResponse = parsed.response ?? buildFallbackResponsesObject(parsed);
      if (upstreamRequest.aliasApplied) {
        completedResponse.model = upstreamRequest.publicModel;
      }
      if (proxyLogger.isEnabled()) {
        upstreamDetails.sse_events = events;
      }
      await proxyLogger.record({
        kind: "request",
        action: "responses.create",
        method: request.method,
        path: routePath,
        statusCode: 200,
        durationMs: Date.now() - startedAt,
        request: requestDetails as JsonMap,
        upstream: upstreamDetails,
        response: {
          body: completedResponse,
        },
      });
      return reply.send(completedResponse);
    } catch (error) {
      const statusCode = statusCodeFromError(error);
      const body = proxyErrorBody(error);
      await proxyLogger.record({
        kind: "request",
        action: Boolean(requestBody.stream) ? "responses.create.stream" : "responses.create",
        method: request.method,
        path: routePath,
        statusCode,
        durationMs: Date.now() - startedAt,
        request: requestDetails as JsonMap,
        error: serializeError(error),
        response: {
          body,
        },
      });
      return reply.code(statusCode).send(body);
    }
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const startedAt = Date.now();
    const rawRequestBody = (request.body ?? {}) as JsonMap;
    const cursorProfile = applyCursorGpt54Profile(
      rawRequestBody,
      request.headers as Record<string, unknown>,
    );
    const requestBody = cursorProfile.body;
    const routePath = requestPath(request.url);
    const requestDetails = {
      headers: sanitizeHeaders(request.headers as Record<string, unknown>),
      body: sanitizeForLog(requestBody),
      cursor_profile: {
        detected: cursorProfile.detected,
        applied: cursorProfile.applied,
        matched_by: cursorProfile.matchedBy,
      },
    };

    try {
      await ensureAuthorized(request.headers as Record<string, unknown>, apiKeyStore);
      const streamRequested = Boolean(requestBody.stream);
      const upstreamRequest = buildUpstreamChatRequest(requestBody, config);
      const upstream = await postUpstreamResponses(config, upstreamRequest.upstreamBody);
      const upstreamDetails: JsonMap = {
        endpoint: "responses",
        url: `${config.upstreamBaseUrl}/responses`,
        method: "POST",
        request_body: upstreamRequest.upstreamBody,
        alias_applied: upstreamRequest.aliasApplied,
        public_model: upstreamRequest.publicModel,
        cursor_profile_applied: cursorProfile.applied,
        cursor_profile_matched_by: cursorProfile.matchedBy,
        status: upstream.status,
      };

      if (!upstream.ok) {
        const relayed = await relayUpstreamError(upstream);
        upstreamDetails.response_body = relayed.body;
        await proxyLogger.record({
          kind: "request",
          action: streamRequested ? "chat.completions.stream" : "chat.completions.create",
          method: request.method,
          path: routePath,
          statusCode: relayed.statusCode,
          durationMs: Date.now() - startedAt,
          request: requestDetails as JsonMap,
          upstream: upstreamDetails,
          response: {
            body: relayed.body,
          },
        });
        return reply.code(relayed.statusCode).send(relayed.body);
      }

      if (!upstream.body) {
        const body = {
          error: {
            message: "Upstream response body was empty",
            type: "upstream_error",
          },
        };
        await proxyLogger.record({
          kind: "request",
          action: streamRequested ? "chat.completions.stream" : "chat.completions.create",
          method: request.method,
          path: routePath,
          statusCode: 502,
          durationMs: Date.now() - startedAt,
          request: requestDetails as JsonMap,
          upstream: upstreamDetails,
          response: {
            body,
          },
        });
        return reply.code(502).send(body);
      }

      if (!streamRequested) {
        const frames = await collectSseFrames(upstream.body);
        const events = frames.map(safeParseSseJson);
        const parsed = parseUpstreamResponsePayload(events);
        const responseBody = toChatCompletionResponse(parsed);
        if (upstreamRequest.aliasApplied) {
          responseBody.model = upstreamRequest.publicModel;
        }
        if (proxyLogger.isEnabled()) {
          upstreamDetails.sse_events = events;
        }
        await proxyLogger.record({
          kind: "request",
          action: "chat.completions.create",
          method: request.method,
          path: routePath,
          statusCode: 200,
          durationMs: Date.now() - startedAt,
          request: requestDetails as JsonMap,
          upstream: upstreamDetails,
          response: {
            body: responseBody,
          },
        });
        return reply.send(responseBody);
      }

      const captureEvents = proxyLogger.isEnabled();
      const loggedEvents: unknown[] = [];

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      let sentRole = false;
      let responseId = `chatcmpl_${Date.now()}`;
      let model = upstreamRequest.publicModel;
      let created = Math.floor(Date.now() / 1000);
      let toolIndex = 0;
      let finishReason: "stop" | "tool_calls" = "stop";
      const streamedToolCalls = new Map<
        string,
        {
          index: number;
          callId: string;
          name: string;
          announced: boolean;
          sawArgumentDelta: boolean;
        }
      >();
      const includeUsage =
        Boolean(requestBody.stream_options) &&
        typeof requestBody.stream_options === "object" &&
        Boolean((requestBody.stream_options as JsonMap).include_usage);

      const writeChunk = (
        delta: JsonMap,
        finish: string | null = null,
        extras?: JsonMap,
      ) => {
        reply.raw.write(
          formatSseData({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            ...(extras ?? {}),
            choices: [
              {
                index: 0,
                delta,
                finish_reason: finish,
              },
            ],
          }),
        );
      };

      const ensureToolCallMeta = (
        itemId: string,
        fallback?: {
          callId?: string;
          name?: string;
        },
      ) => {
        let meta = streamedToolCalls.get(itemId);
        if (!meta) {
          meta = {
            index: toolIndex++,
            callId: fallback?.callId ?? `call_${toolIndex}`,
            name: fallback?.name ?? "function",
            announced: false,
            sawArgumentDelta: false,
          };
          streamedToolCalls.set(itemId, meta);
        } else {
          if (fallback?.callId) {
            meta.callId = fallback.callId;
          }
          if (fallback?.name) {
            meta.name = fallback.name;
          }
        }
        return meta;
      };

      const announceToolCall = (meta: {
        index: number;
        callId: string;
        name: string;
        announced: boolean;
      }) => {
        if (!sentRole) {
          writeChunk({ role: "assistant" });
          sentRole = true;
        }
        if (meta.announced) {
          return;
        }
        finishReason = "tool_calls";
        writeChunk({
          tool_calls: [
            {
              index: meta.index,
              id: meta.callId,
              type: "function",
              function: {
                name: meta.name,
                arguments: "",
              },
            },
          ],
        });
        meta.announced = true;
      };

      for await (const frame of iterateSseFrames(upstream.body)) {
        const event = safeParseSseJson(frame);
        if (captureEvents) {
          loggedEvents.push(event ?? { event: frame.event, data: frame.data, raw: frame.raw });
        }
        if (!event) {
          continue;
        }

        const type = typeof event.type === "string" ? event.type : "";
        if (type === "response.created" && event.response && typeof event.response === "object") {
          const responseObj = event.response as JsonMap;
          responseId = String(responseObj.id ?? responseId);
          if (!upstreamRequest.aliasApplied) {
            model = String(responseObj.model ?? model);
          }
          created =
            typeof responseObj.created_at === "number"
              ? responseObj.created_at
              : created;
          continue;
        }

        if (type === "response.output_text.delta") {
          if (!sentRole) {
            writeChunk({ role: "assistant" });
            sentRole = true;
          }
          writeChunk({ content: String(event.delta ?? "") });
          continue;
        }

        if (type === "response.output_item.added" && event.item && typeof event.item === "object") {
          const item = event.item as JsonMap;
          if (item.type === "function_call" || item.type === "custom_tool_call") {
            const itemId = String(item.id ?? `tool_${toolIndex}`);
            const meta = ensureToolCallMeta(itemId, {
              callId: String(item.call_id ?? `call_${toolIndex}`),
              name: String(item.name ?? (item.type === "custom_tool_call" ? "tool" : "function")),
            });
            announceToolCall(meta);
          }
          continue;
        }

        if (type === "response.function_call_arguments.delta") {
          const itemId = String(event.item_id ?? `tool_${toolIndex}`);
          const meta = ensureToolCallMeta(itemId);
          announceToolCall(meta);
          meta.sawArgumentDelta = true;
          writeChunk({
            tool_calls: [
              {
                index: meta.index,
                function: {
                  arguments: String(event.delta ?? ""),
                },
              },
            ],
          });
          continue;
        }

        if (type === "response.custom_tool_call_input.delta") {
          const itemId = String(event.item_id ?? `tool_${toolIndex}`);
          const meta = ensureToolCallMeta(itemId);
          announceToolCall(meta);
          meta.sawArgumentDelta = true;
          writeChunk({
            tool_calls: [
              {
                index: meta.index,
                function: {
                  arguments: String(event.delta ?? ""),
                },
              },
            ],
          });
          continue;
        }

        if (type === "response.output_item.done" && event.item && typeof event.item === "object") {
          const item = event.item as JsonMap;
          if (item.type === "function_call" || item.type === "custom_tool_call") {
            const itemId = String(item.id ?? `tool_${toolIndex}`);
            const meta = ensureToolCallMeta(itemId, {
              callId: String(item.call_id ?? `call_${toolIndex}`),
              name: String(item.name ?? (item.type === "custom_tool_call" ? "tool" : "function")),
            });
            const fullArguments =
              item.type === "custom_tool_call"
                ? (typeof item.input === "string"
                    ? item.input
                    : JSON.stringify(item.input ?? {}))
                : (typeof item.arguments === "string"
                    ? item.arguments
                    : JSON.stringify(item.arguments ?? {}));
            announceToolCall(meta);
            if (!meta.sawArgumentDelta && fullArguments) {
              writeChunk({
                tool_calls: [
                  {
                    index: meta.index,
                    function: {
                      arguments: fullArguments,
                    },
                  },
                ],
              });
            }
            finishReason = "tool_calls";
          }
          continue;
        }

        if (type === "response.completed") {
          const completedResponse =
            event.response && typeof event.response === "object"
              ? (event.response as JsonMap)
              : null;
          const usage = toChatCompletionUsage(completedResponse);
          if (!sentRole) {
            writeChunk({ role: "assistant" });
          }
          writeChunk({}, finishReason, includeUsage && usage ? { usage } : undefined);
          if (includeUsage) {
            if (usage) {
              reply.raw.write(
                formatSseData({
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [],
                  usage,
                }),
              );
            }
          }
          reply.raw.write("data: [DONE]\n\n");
          reply.raw.end();
          if (proxyLogger.isEnabled()) {
            upstreamDetails.sse_events = loggedEvents;
            await proxyLogger.record({
              kind: "request",
              action: "chat.completions.stream",
              method: request.method,
              path: routePath,
              statusCode: 200,
              durationMs: Date.now() - startedAt,
              request: requestDetails as JsonMap,
              upstream: upstreamDetails,
              response: {
                stream: true,
                model,
                finish_reason: finishReason,
              },
            });
          }
          return reply;
        }
      }

      if (!sentRole) {
        writeChunk({ role: "assistant" });
      }
      writeChunk({}, finishReason);
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      if (proxyLogger.isEnabled()) {
        upstreamDetails.sse_events = loggedEvents;
        await proxyLogger.record({
          kind: "request",
          action: "chat.completions.stream",
          method: request.method,
          path: routePath,
          statusCode: 200,
          durationMs: Date.now() - startedAt,
          request: requestDetails as JsonMap,
          upstream: upstreamDetails,
          response: {
            stream: true,
            model,
            finish_reason: finishReason,
          },
        });
      }
      return reply;
    } catch (error) {
      const statusCode = statusCodeFromError(error);
      const body = proxyErrorBody(error);
      await proxyLogger.record({
        kind: "request",
        action: Boolean(requestBody.stream) ? "chat.completions.stream" : "chat.completions.create",
        method: request.method,
        path: routePath,
        statusCode,
        durationMs: Date.now() - startedAt,
        request: requestDetails as JsonMap,
        error: serializeError(error),
        response: {
          body,
        },
      });
      return reply.code(statusCode).send(body);
    }
  });

  return app;
}
