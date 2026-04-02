import { Readable } from "node:stream";

import Fastify from "fastify";

import type { AppConfig } from "./config.js";
import { fetchWithAuthRetry, resolveUpstreamAuth } from "./auth.js";
import {
  buildFallbackResponsesObject,
  buildUpstreamChatRequest,
  buildUpstreamResponsesRequest,
  parseUpstreamResponsePayload,
  toChatCompletionResponse,
  toModelsResponse,
  type JsonMap,
} from "./openai.js";
import {
  collectSseFrames,
  formatSseData,
  iterateSseFrames,
  safeParseSseJson,
} from "./sse.js";

function ensureAuthorized(requestHeaders: Record<string, unknown>, proxyApiKey?: string): void {
  if (!proxyApiKey) {
    return;
  }
  const authHeader = requestHeaders.authorization;
  const token =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;
  if (token !== proxyApiKey) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
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

  let cachedModels:
    | {
        expiresAt: number;
        body: JsonMap;
      }
    | undefined;

  app.get("/health", async () => {
    const auth = await resolveUpstreamAuth(config);
    return {
      ok: true,
      upstream_base_url: config.upstreamBaseUrl,
      auth_json_path: config.authJsonPath,
      account_id: auth.accountId,
      client_version: config.clientVersion,
    };
  });

  app.get("/v1/models", async (request, reply) => {
    try {
      ensureAuthorized(request.headers as Record<string, unknown>, config.proxyApiKey);
      const now = Date.now();
      if (cachedModels && cachedModels.expiresAt > now) {
        return cachedModels.body;
      }

      const url = new URL(`${config.upstreamBaseUrl}/models`);
      url.searchParams.set("client_version", config.clientVersion);
      const upstream = await fetchUpstreamModelsWithRetry(config, url.toString());

      if (!upstream.ok) {
        const relayed = await relayUpstreamError(upstream);
        return reply.code(relayed.statusCode).send(relayed.body);
      }

      const payload = (await upstream.json()) as JsonMap;
      const models = Array.isArray(payload.models)
        ? (payload.models.filter(
            (value): value is JsonMap => Boolean(value) && typeof value === "object",
          ) as JsonMap[])
        : [];
      const body = toModelsResponse(models);
      cachedModels = {
        expiresAt: now + 60_000,
        body,
      };
      return body;
    } catch (error) {
      const statusCode =
        typeof (error as { statusCode?: unknown }).statusCode === "number"
          ? ((error as { statusCode: number }).statusCode)
          : 500;
      return reply.code(statusCode).send({
        error: {
          message: error instanceof Error ? error.message : "Unexpected error",
          type: "proxy_error",
        },
      });
    }
  });

  app.post("/v1/responses", async (request, reply) => {
    try {
      ensureAuthorized(request.headers as Record<string, unknown>, config.proxyApiKey);
      const body = (request.body ?? {}) as JsonMap;
      const upstreamRequest = buildUpstreamResponsesRequest(body, config.defaultModel);
      const streamRequested = Boolean(body.stream);
      const upstream = await postUpstreamResponses(config, upstreamRequest);

      if (!upstream.ok) {
        const relayed = await relayUpstreamError(upstream);
        return reply.code(relayed.statusCode).send(relayed.body);
      }

      if (!upstream.body) {
        return reply.code(502).send({
          error: {
            message: "Upstream response body was empty",
            type: "upstream_error",
          },
        });
      }

      if (streamRequested) {
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for await (const chunk of Readable.fromWeb(upstream.body as never)) {
          reply.raw.write(chunk);
        }
        reply.raw.end();
        return reply;
      }

      const frames = await collectSseFrames(upstream.body);
      const events = frames.map(safeParseSseJson);
      const parsed = parseUpstreamResponsePayload(events);
      const completedResponse = parsed.response ?? buildFallbackResponsesObject(parsed);
      return reply.send(completedResponse);
    } catch (error) {
      const statusCode =
        typeof (error as { statusCode?: unknown }).statusCode === "number"
          ? ((error as { statusCode: number }).statusCode)
          : 500;
      return reply.code(statusCode).send({
        error: {
          message: error instanceof Error ? error.message : "Unexpected error",
          type: "proxy_error",
        },
      });
    }
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    try {
      ensureAuthorized(request.headers as Record<string, unknown>, config.proxyApiKey);
      const body = (request.body ?? {}) as JsonMap;
      const streamRequested = Boolean(body.stream);
      const upstreamRequest = buildUpstreamChatRequest(body, config.defaultModel);
      const upstream = await postUpstreamResponses(config, upstreamRequest);

      if (!upstream.ok) {
        const relayed = await relayUpstreamError(upstream);
        return reply.code(relayed.statusCode).send(relayed.body);
      }

      if (!upstream.body) {
        return reply.code(502).send({
          error: {
            message: "Upstream response body was empty",
            type: "upstream_error",
          },
        });
      }

      if (!streamRequested) {
        const frames = await collectSseFrames(upstream.body);
        const events = frames.map(safeParseSseJson);
        const parsed = parseUpstreamResponsePayload(events);
        return reply.send(toChatCompletionResponse(parsed));
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      let sentRole = false;
      let responseId = `chatcmpl_${Date.now()}`;
      let model = String(body.model ?? config.defaultModel);
      let created = Math.floor(Date.now() / 1000);
      let toolIndex = 0;
      let finishReason: "stop" | "tool_calls" = "stop";

      const writeChunk = (delta: JsonMap, finish: string | null = null) => {
        reply.raw.write(
          formatSseData({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
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

      for await (const frame of iterateSseFrames(upstream.body)) {
        const event = safeParseSseJson(frame);
        if (!event) {
          continue;
        }

        const type = typeof event.type === "string" ? event.type : "";
        if (type === "response.created" && event.response && typeof event.response === "object") {
          const responseObj = event.response as JsonMap;
          responseId = String(responseObj.id ?? responseId);
          model = String(responseObj.model ?? model);
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

        if (type === "response.output_item.done" && event.item && typeof event.item === "object") {
          const item = event.item as JsonMap;
          if (item.type === "function_call") {
            if (!sentRole) {
              writeChunk({ role: "assistant" });
              sentRole = true;
            }
            finishReason = "tool_calls";
            writeChunk({
              tool_calls: [
                {
                  index: toolIndex,
                  id: String(item.call_id ?? `call_${toolIndex}`),
                  type: "function",
                  function: {
                    name: String(item.name ?? "function"),
                    arguments:
                      typeof item.arguments === "string"
                        ? item.arguments
                        : JSON.stringify(item.arguments ?? {}),
                  },
                },
              ],
            });
            toolIndex += 1;
          }
          continue;
        }

        if (type === "response.completed") {
          if (!sentRole) {
            writeChunk({ role: "assistant" });
          }
          writeChunk({}, finishReason);
          reply.raw.write("data: [DONE]\n\n");
          reply.raw.end();
          return reply;
        }
      }

      if (!sentRole) {
        writeChunk({ role: "assistant" });
      }
      writeChunk({}, finishReason);
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return reply;
    } catch (error) {
      const statusCode =
        typeof (error as { statusCode?: unknown }).statusCode === "number"
          ? ((error as { statusCode: number }).statusCode)
          : 500;
      return reply.code(statusCode).send({
        error: {
          message: error instanceof Error ? error.message : "Unexpected error",
          type: "proxy_error",
        },
      });
    }
  });

  return app;
}
