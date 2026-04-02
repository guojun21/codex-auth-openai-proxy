import { randomUUID } from "node:crypto";
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

function makeConfig(authJsonPath: string, baseUrl: string, refreshUrl?: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    authJsonPath,
    upstreamBaseUrl: `${baseUrl}/backend-api/codex`,
    refreshUrl: refreshUrl ?? `${baseUrl}/oauth/token`,
    clientVersion: "0.111.0",
    defaultModel: "gpt-5.4",
    requestTimeoutMs: 10_000,
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
        makeConfig(authPath, upstream.baseUrl, `${upstream.baseUrl}/oauth/token`),
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
