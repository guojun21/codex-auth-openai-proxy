import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CHATGPT_REFRESH_CLIENT_ID } from "../src/auth.js";
import type { AppConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  bodyText: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "codex-auth-proxy-test-"));
}

function makeJwt(expOffsetSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + expOffsetSeconds,
      sub: "test-user",
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

async function writeAuthFile(
  rootDir: string,
  overrides?: {
    accessToken?: string;
    refreshToken?: string;
    accountId?: string;
  },
): Promise<string> {
  const authPath = path.join(rootDir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify(
      {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          access_token: overrides?.accessToken ?? makeJwt(3600),
          refresh_token: overrides?.refreshToken ?? "refresh-token-1",
          id_token: "id-token-1",
          account_id: overrides?.accountId ?? "acct-1",
        },
        last_refresh: null,
      },
      null,
      2,
    ),
  );
  return authPath;
}

async function startMockServer(
  handler: (
    request: RecordedRequest,
    res: ServerResponse<IncomingMessage>,
  ) => Promise<void> | void,
): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const bodyText = await readBody(req);
    const recorded: RecordedRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      bodyText,
    };
    requests.push(recorded);
    await handler(recorded, res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine mock server address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function sse(...events: unknown[]): string {
  return events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function makeConfig(
  authJsonPath: string,
  baseUrl: string,
  options?: {
    refreshUrl?: string;
    proxyApiKey?: string;
    proxyLoggingEnabledDefault?: boolean;
    logReadLimitMax?: number;
    alias?: string;
  },
): AppConfig {
  const rootDir = path.dirname(authJsonPath);
  return {
    host: "127.0.0.1",
    port: 0,
    authJsonPath,
    upstreamBaseUrl: `${baseUrl}/backend-api/codex`,
    refreshUrl: options?.refreshUrl ?? `${baseUrl}/oauth/token`,
    clientVersion: "0.111.0",
    defaultModel: "gpt-5.4",
    proxyApiKey: options?.proxyApiKey,
    requestTimeoutMs: 10_000,
    proxyLoggingEnabledDefault: options?.proxyLoggingEnabledDefault ?? false,
    proxyLogFilePath: path.join(rootDir, "request-debug.jsonl"),
    proxyLogStatePath: path.join(rootDir, "logging-state.json"),
    proxyLogReadLimitMax: options?.logReadLimitMax ?? 50,
    gpt54FastXhighAlias: {
      alias: options?.alias ?? "codex-gpt-5-4-fast-xhigh",
      upstreamModel: "gpt-5.4",
      reasoningEffort: "xhigh",
      reasoningSummary: "auto",
      serviceTier: "priority",
    },
  };
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })),
  );
});

describe("codex-auth-openai-proxy", () => {
  it("returns OpenAI-compatible models from the upstream /models endpoint", async () => {
    const tempDir = await makeTempDir();
    cleanupPaths.push(tempDir);
    const authPath = await writeAuthFile(tempDir);
    const upstream = await startMockServer((request, res) => {
      expect(request.path).toBe("/backend-api/codex/models");
      expect(request.query.get("client_version")).toBe("0.111.0");
      expect(request.headers.authorization).toMatch(/^Bearer /);
      expect(request.headers["chatgpt-account-id"]).toBe("acct-1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            { slug: "gpt-5.4", visibility: "list" },
            { slug: "hidden-model", visibility: "hidden" },
          ],
        }),
      );
    });

    try {
      const app = await buildServer(makeConfig(authPath, upstream.baseUrl));
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        object: "list",
        data: [
          {
            id: "codex-gpt-5-4-fast-xhigh",
            object: "model",
            created: 0,
            owned_by: "codex-auth-openai-proxy",
          },
          {
            id: "gpt-5.4",
            object: "model",
            created: 0,
            owned_by: "openai",
          },
        ],
      });
      await app.close();
    } finally {
      await upstream.close();
    }
  });

  it("exposes an alias for gpt-5.4 fast+xhigh and maps it back to the upstream model", async () => {
    const tempDir = await makeTempDir();
    cleanupPaths.push(tempDir);
    const authPath = await writeAuthFile(tempDir);
    const upstream = await startMockServer((request, res) => {
      expect(request.path).toBe("/backend-api/codex/responses");
      const body = JSON.parse(request.bodyText) as Record<string, unknown>;
      expect(body.model).toBe("gpt-5.4");
      expect(body.reasoning).toEqual({
        effort: "xhigh",
        summary: "none",
      });
      expect(body.service_tier).toBe("priority");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(
          {
            type: "response.created",
            response: {
              id: "resp_alias_1",
              created_at: 7,
              model: "gpt-5.4",
            },
          },
          {
            type: "response.output_text.done",
            text: "ALIAS_OK",
          },
          {
            type: "response.completed",
            response: {
              id: "resp_alias_1",
              created_at: 7,
              model: "gpt-5.4",
              usage: {
                input_tokens: 4,
                output_tokens: 2,
                total_tokens: 6,
              },
            },
          },
        ),
      );
    });

    try {
      const app = await buildServer(makeConfig(authPath, upstream.baseUrl));
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "codex-gpt-5-4-fast-xhigh",
          messages: [{ role: "user", content: "hello" }],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: "resp_alias_1",
        model: "codex-gpt-5-4-fast-xhigh",
        choices: [
          {
            message: {
              content: "ALIAS_OK",
            },
          },
        ],
      });
      await app.close();
    } finally {
      await upstream.close();
    }
  });

  it("converts non-streaming /v1/responses requests into upstream SSE requests", async () => {
    const tempDir = await makeTempDir();
    cleanupPaths.push(tempDir);
    const authPath = await writeAuthFile(tempDir);
    const upstream = await startMockServer((request, res) => {
      expect(request.path).toBe("/backend-api/codex/responses");
      const body = JSON.parse(request.bodyText) as Record<string, unknown>;
      expect(body.instructions).toBe("");
      expect(body.stream).toBe(true);
      expect(body.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(
          {
            type: "response.created",
            response: {
              id: "resp_1",
              created_at: 1,
              model: "gpt-5.4",
              output: [],
            },
          },
          {
            type: "response.output_text.delta",
            delta: "Hello",
          },
          {
            type: "response.output_text.done",
            text: "Hello",
          },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              created_at: 1,
              model: "gpt-5.4",
              status: "completed",
              output: [
                {
                  id: "msg_1",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "Hello" }],
                },
              ],
              usage: {
                input_tokens: 2,
                output_tokens: 1,
                total_tokens: 3,
              },
            },
          },
        ),
      );
    });

    try {
      const app = await buildServer(makeConfig(authPath, upstream.baseUrl));
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "gpt-5.4",
          input: "hello",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: "resp_1",
        status: "completed",
        output: [
          {
            role: "assistant",
            content: [{ text: "Hello" }],
          },
        ],
      });
      await app.close();
    } finally {
      await upstream.close();
    }
  });

  it("converts chat completions requests and returns standard non-streaming chat responses", async () => {
    const tempDir = await makeTempDir();
    cleanupPaths.push(tempDir);
    const authPath = await writeAuthFile(tempDir);
    const upstream = await startMockServer((request, res) => {
      const body = JSON.parse(request.bodyText) as Record<string, unknown>;
      expect(String(body.instructions)).toContain("[system]");
      expect(String(body.instructions)).toContain("be terse");
      expect(body.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ]);
      expect(body.reasoning).toEqual({
        effort: "xhigh",
        summary: "auto",
      });
      expect(body.service_tier).toBe("priority");
      expect(body.text).toEqual({
        verbosity: "high",
      });
      expect(body.include).toEqual(["reasoning.encrypted_content"]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(
          {
            type: "response.created",
            response: {
              id: "resp_chat_1",
              created_at: 123,
              model: "gpt-5.4",
            },
          },
          {
            type: "response.output_text.delta",
            delta: "TERSE",
          },
          {
            type: "response.output_text.done",
            text: "TERSE",
          },
          {
            type: "response.completed",
            response: {
              id: "resp_chat_1",
              created_at: 123,
              model: "gpt-5.4",
              usage: {
                input_tokens: 4,
                output_tokens: 1,
                total_tokens: 5,
              },
            },
          },
        ),
      );
    });

    try {
      const app = await buildServer(makeConfig(authPath, upstream.baseUrl));
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "gpt-5.4",
          reasoning_effort: "xhigh",
          reasoning_summary: "auto",
          service_tier: "priority",
          verbosity: "high",
          include: ["reasoning.encrypted_content"],
          messages: [
            { role: "system", content: "be terse" },
            { role: "user", content: "hello" },
          ],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id: "resp_chat_1",
        object: "chat.completion",
        created: 123,
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "TERSE",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 1,
          total_tokens: 5,
        },
      });
      await app.close();
    } finally {
      await upstream.close();
    }
  });

  it("accepts Cursor-style input arrays on /v1/chat/completions", async () => {
    const tempDir = await makeTempDir();
    cleanupPaths.push(tempDir);
    const authPath = await writeAuthFile(tempDir);
    const upstream = await startMockServer((request, res) => {
      const body = JSON.parse(request.bodyText) as Record<string, unknown>;
      expect(String(body.instructions)).toContain("[system]");
      expect(String(body.instructions)).toContain("be terse");
      expect(body.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(
          {
            type: "response.output_text.done",
            text: "CURSOR_INPUT_OK",
          },
          {
            type: "response.completed",
            response: {
              id: "resp_cursor_input_1",
              created_at: 456,
              model: "gpt-5.4",
              usage: {
                input_tokens: 6,
                output_tokens: 2,
                total_tokens: 8,
              },
              output: [
                {
                  id: "msg_cursor_input_1",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "CURSOR_INPUT_OK" }],
                },
              ],
            },
          },
        ),
      );
    });

    try {
      const app = await buildServer(makeConfig(authPath, upstream.baseUrl));
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "gpt-5.4",
          input: [
            { role: "system", content: "be terse" },
            { role: "user", content: "hello" },
          ],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id: "resp_cursor_input_1",
        object: "chat.completion",
        created: 456,
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "CURSOR_INPUT_OK",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 6,
          completion_tokens: 2,
          total_tokens: 8,
        },
      });
      await app.close();
    } finally {
      await upstream.close();
    }
  });

  it("accepts shorthand reasoning and verbosity fields for /v1/responses", async () => {
    const tempDir = await makeTempDir();
    cleanupPaths.push(tempDir);
    const authPath = await writeAuthFile(tempDir);
    const upstream = await startMockServer((request, res) => {
      const body = JSON.parse(request.bodyText) as Record<string, unknown>;
      expect(body.reasoning).toEqual({
        effort: "low",
        summary: "auto",
      });
      expect(body.service_tier).toBe("flex");
      expect(body.text).toEqual({
        verbosity: "low",
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(
          {
            type: "response.completed",
            response: {
              id: "resp_short_1",
              created_at: 5,
              model: "gpt-5.4",
              status: "completed",
              output: [
                {
                  id: "msg_short_1",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "FAST" }],
                },
              ],
            },
          },
        ),
      );
    });

    try {
      const app = await buildServer(makeConfig(authPath, upstream.baseUrl));
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "gpt-5.4",
          input: "hello",
          reasoning_effort: "fast",
          reasoning_summary: "auto",
          service_tier: "flex",
          verbosity: "low",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: "resp_short_1",
        status: "completed",
      });
      await app.close();
    } finally {
      await upstream.close();
    }
  });

  it("forces Cursor gpt-5.4 requests onto priority + xhigh without changing the public model name", async () => {
    const tempDir = await makeTempDir();
    cleanupPaths.push(tempDir);
    const authPath = await writeAuthFile(tempDir);
    const upstream = await startMockServer((request, res) => {
      expect(request.path).toBe("/backend-api/codex/responses");
      const body = JSON.parse(request.bodyText) as Record<string, unknown>;
      expect(body.model).toBe("gpt-5.4");
      expect(body.reasoning).toEqual({
        effort: "xhigh",
        summary: "auto",
      });
      expect(body.service_tier).toBe("priority");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(
          {
            type: "response.created",
            response: {
              id: "resp_cursor_1",
              created_at: 42,
              model: "gpt-5.4",
            },
          },
          {
            type: "response.output_text.done",
            text: "CURSOR_FORCE_OK",
          },
          {
            type: "response.completed",
            response: {
              id: "resp_cursor_1",
              created_at: 42,
              model: "gpt-5.4",
            },
          },
        ),
      );
    });

    try {
      const app = await buildServer(makeConfig(authPath, upstream.baseUrl));
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "user-agent": "Cursor/2.6.22",
        },
        payload: {
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hello" }],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: "resp_cursor_1",
        model: "gpt-5.4",
        choices: [
          {
            message: {
              content: "CURSOR_FORCE_OK",
            },
          },
        ],
      });
      await app.close();
    } finally {
      await upstream.close();
    }
  });

  it("streams OpenAI chat completion chunks derived from upstream response deltas", async () => {
    const tempDir = await makeTempDir();
    cleanupPaths.push(tempDir);
    const authPath = await writeAuthFile(tempDir);
    const upstream = await startMockServer((request, res) => {
      expect(request.path).toBe("/backend-api/codex/responses");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(
          {
            type: "response.created",
            response: {
              id: "resp_stream_1",
              created_at: 99,
              model: "gpt-5.4",
            },
          },
          {
            type: "response.output_text.delta",
            delta: "Hi",
          },
          {
            type: "response.completed",
            response: {
              id: "resp_stream_1",
              created_at: 99,
              model: "gpt-5.4",
            },
          },
        ),
      );
    });

    try {
      const app = await buildServer(makeConfig(authPath, upstream.baseUrl));
      const listen = await app.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(`${listen}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain('"object":"chat.completion.chunk"');
      expect(body).toContain('"content":"Hi"');
      expect(body).toContain("data: [DONE]");
      await app.close();
    } finally {
      await upstream.close();
    }
  });

  it("emits a final usage chunk for streamed chat completions when include_usage is requested", async () => {
    const tempDir = await makeTempDir();
    cleanupPaths.push(tempDir);
    const authPath = await writeAuthFile(tempDir);
    const upstream = await startMockServer((request, res) => {
      expect(request.path).toBe("/backend-api/codex/responses");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(
          {
            type: "response.created",
            response: {
              id: "resp_stream_usage_1",
              created_at: 100,
              model: "gpt-5.4",
            },
          },
          {
            type: "response.output_text.delta",
            delta: "Hi",
          },
          {
            type: "response.completed",
            response: {
              id: "resp_stream_usage_1",
              created_at: 100,
              model: "gpt-5.4",
              usage: {
                input_tokens: 7,
                output_tokens: 3,
                total_tokens: 10,
              },
            },
          },
        ),
      );
    });

    try {
      const app = await buildServer(makeConfig(authPath, upstream.baseUrl));
      const listen = await app.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(`${listen}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain('"content":"Hi"');
      expect(body).toContain('"choices":[]');
      expect(body).toContain('"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}');
      expect(body).toContain("data: [DONE]");
      await app.close();
    } finally {
      await upstream.close();
    }
  });

  it("writes detailed logs only while logging is enabled and exposes them over admin APIs", async () => {
    const tempDir = await makeTempDir();
    cleanupPaths.push(tempDir);
    const authPath = await writeAuthFile(tempDir);
    const proxyApiKey = "proxy-secret";
    const upstream = await startMockServer((request, res) => {
      if (request.path !== "/backend-api/codex/responses") {
        res.writeHead(404).end();
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse(
          {
            type: "response.created",
            response: {
              id: "resp_log_1",
              created_at: 12,
              model: "gpt-5.4",
            },
          },
          {
            type: "response.output_text.delta",
            delta: "LOG",
          },
          {
            type: "response.output_text.done",
            text: "LOG",
          },
          {
            type: "response.completed",
            response: {
              id: "resp_log_1",
              created_at: 12,
              model: "gpt-5.4",
            },
          },
        ),
      );
    });

    try {
      const config = makeConfig(authPath, upstream.baseUrl, {
        proxyApiKey,
      });
      const app = await buildServer(config);
      const authHeader = { authorization: `Bearer ${proxyApiKey}` };

      const initialStatus = await app.inject({
        method: "GET",
        url: "/admin/logging",
        headers: authHeader,
      });
      expect(initialStatus.statusCode).toBe(200);
      expect(initialStatus.json()).toMatchObject({
        enabled: false,
      });

      const enableResponse = await app.inject({
        method: "POST",
        url: "/admin/logging",
        headers: authHeader,
        payload: {
          enabled: true,
        },
      });
      expect(enableResponse.statusCode).toBe(200);
      expect(enableResponse.json()).toMatchObject({
        enabled: true,
      });

      const completionResponse = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          ...authHeader,
          "content-type": "application/json",
        },
        payload: {
          model: "codex-gpt-5-4-fast-xhigh",
          messages: [{ role: "user", content: "hello log" }],
        },
      });
      expect(completionResponse.statusCode).toBe(200);

      const logsResponse = await app.inject({
        method: "GET",
        url: "/admin/logs?limit=10",
        headers: authHeader,
      });
      expect(logsResponse.statusCode).toBe(200);
      const logsPayload = logsResponse.json() as {
        enabled: boolean;
        entries: Array<Record<string, unknown>>;
      };
      expect(logsPayload.enabled).toBe(true);
      expect(logsPayload.entries.length).toBe(2);

      const controlEntry = logsPayload.entries.find(
        (entry) => entry.action === "logging.set_enabled",
      );
      expect(controlEntry).toBeTruthy();
      expect(controlEntry).toMatchObject({
        kind: "control",
        enabled: true,
      });

      const requestEntry = logsPayload.entries.find(
        (entry) => entry.action === "chat.completions.create",
      );
      expect(requestEntry).toBeTruthy();
      expect(requestEntry).toMatchObject({
        kind: "request",
        method: "POST",
        path: "/v1/chat/completions",
        statusCode: 200,
      });
      expect(requestEntry?.request).toMatchObject({
        headers: {
          authorization: "[redacted]",
        },
        body: {
          model: "codex-gpt-5-4-fast-xhigh",
        },
      });
      expect(requestEntry?.upstream).toMatchObject({
        request_body: {
          model: "gpt-5.4",
          reasoning: {
            effort: "xhigh",
            summary: "auto",
          },
          service_tier: "priority",
        },
        public_model: "codex-gpt-5-4-fast-xhigh",
      });
      expect((requestEntry?.upstream as Record<string, unknown>).sse_events).toBeInstanceOf(
        Array,
      );

      const logFileBeforeDisable = await readFile(config.proxyLogFilePath, "utf8");

      const disableResponse = await app.inject({
        method: "POST",
        url: "/admin/logging",
        headers: authHeader,
        payload: {
          enabled: false,
        },
      });
      expect(disableResponse.statusCode).toBe(200);
      expect(disableResponse.json()).toMatchObject({
        enabled: false,
      });

      const secondCompletionResponse = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          ...authHeader,
          "content-type": "application/json",
        },
        payload: {
          model: "codex-gpt-5-4-fast-xhigh",
          messages: [{ role: "user", content: "hello again" }],
        },
      });
      expect(secondCompletionResponse.statusCode).toBe(200);

      const logFileAfterDisable = await readFile(config.proxyLogFilePath, "utf8");
      expect(logFileAfterDisable).toBe(logFileBeforeDisable);

      const logsAfterDisable = await app.inject({
        method: "GET",
        url: "/admin/logs?limit=10",
        headers: authHeader,
      });
      expect(logsAfterDisable.statusCode).toBe(200);
      expect((logsAfterDisable.json() as { entries: unknown[] }).entries).toHaveLength(2);

      await app.close();
    } finally {
      await upstream.close();
    }
  });

  it("refreshes auth tokens and retries the upstream request after a 401", async () => {
    const tempDir = await makeTempDir();
    cleanupPaths.push(tempDir);
    const authPath = await writeAuthFile(tempDir, {
      accessToken: makeJwt(3600),
      refreshToken: "refresh-token-1",
      accountId: "acct-1",
    });

    let modelRequestCount = 0;
    const oldToken = JSON.parse(await readFile(authPath, "utf8")).tokens.access_token;
    const newToken = makeJwt(7200);

    const upstream = await startMockServer((request, res) => {
      if (request.path === "/oauth/token") {
        const body = JSON.parse(request.bodyText) as Record<string, unknown>;
        expect(body).toEqual({
          client_id: CHATGPT_REFRESH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: "refresh-token-1",
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: newToken,
            refresh_token: "refresh-token-2",
            id_token: "id-token-2",
          }),
        );
        return;
      }

      if (request.path === "/backend-api/codex/models") {
        modelRequestCount += 1;
        const authHeader = request.headers.authorization;
        if (modelRequestCount === 1) {
          expect(authHeader).toBe(`Bearer ${oldToken}`);
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "expired" } }));
          return;
        }

        expect(authHeader).toBe(`Bearer ${newToken}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ slug: "gpt-5.4", visibility: "list" }] }));
        return;
      }

      res.writeHead(404).end();
    });

    try {
      const app = await buildServer(
        makeConfig(authPath, upstream.baseUrl, {
          refreshUrl: `${upstream.baseUrl}/oauth/token`,
        }),
      );
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
      });
      expect(response.statusCode).toBe(200);
      expect(modelRequestCount).toBe(2);

      const refreshed = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
      expect((refreshed.tokens as Record<string, unknown>).access_token).toBe(newToken);
      expect((refreshed.tokens as Record<string, unknown>).refresh_token).toBe(
        "refresh-token-2",
      );
      await app.close();
    } finally {
      await upstream.close();
    }
  });

  it("retries transient 5xx failures for the upstream /models request", async () => {
    const tempDir = await makeTempDir();
    cleanupPaths.push(tempDir);
    const authPath = await writeAuthFile(tempDir);

    let requestCount = 0;
    const upstream = await startMockServer((request, res) => {
      if (request.path !== "/backend-api/codex/models") {
        res.writeHead(404).end();
        return;
      }

      requestCount += 1;
      if (requestCount === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "temporary failure" } }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ slug: "gpt-5.4", visibility: "list" }] }));
    });

    try {
      const app = await buildServer(makeConfig(authPath, upstream.baseUrl));
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
      });
      expect(response.statusCode).toBe(200);
      expect(requestCount).toBe(2);
      await app.close();
    } finally {
      await upstream.close();
    }
  });
});
