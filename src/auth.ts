import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "./config.js";

export const CHATGPT_REFRESH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

interface AuthTokens {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
}

export interface AuthJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: AuthTokens;
  last_refresh?: string | null;
}

export interface UpstreamAuth {
  accessToken: string;
  accountId: string;
}

export async function readAuthJson(authJsonPath: string): Promise<AuthJson> {
  const raw = await readFile(authJsonPath, "utf8");
  return JSON.parse(raw) as AuthJson;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

export function tokenExpiresSoon(
  accessToken: string | undefined,
  nowMs = Date.now(),
): boolean {
  if (!accessToken) {
    return true;
  }

  const payload = decodeJwtPayload(accessToken);
  const exp = payload?.exp;
  if (typeof exp !== "number") {
    return false;
  }

  return exp * 1000 - nowMs < 60_000;
}

async function writeAuthJsonAtomic(
  authJsonPath: string,
  authJson: AuthJson,
): Promise<void> {
  await mkdir(path.dirname(authJsonPath), { recursive: true });
  const tmpPath = `${authJsonPath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(authJson, null, 2)}\n`, "utf8");
  await rename(tmpPath, authJsonPath);
}

export async function refreshAuthJson(
  config: AppConfig,
  authJsonPath: string,
  authJson: AuthJson,
): Promise<AuthJson> {
  const refreshToken = authJson.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error("No refresh_token present in auth.json");
  }

  const response = await fetch(config.refreshUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "codex-auth-openai-proxy/0.1.0",
    },
    body: JSON.stringify({
      client_id: CHATGPT_REFRESH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Refresh token request failed: ${response.status} ${body || "<empty>"}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const nextAccessToken = payload.access_token;
  if (typeof nextAccessToken !== "string" || !nextAccessToken) {
    throw new Error("Refresh response did not contain access_token");
  }

  const nextAuth: AuthJson = {
    ...authJson,
    tokens: {
      ...authJson.tokens,
      access_token: nextAccessToken,
      id_token:
        typeof payload.id_token === "string"
          ? payload.id_token
          : authJson.tokens?.id_token,
      refresh_token:
        typeof payload.refresh_token === "string"
          ? payload.refresh_token
          : refreshToken,
    },
    last_refresh: new Date().toISOString(),
  };

  await writeAuthJsonAtomic(authJsonPath, nextAuth);
  return nextAuth;
}

function assertChatGptTokens(authJson: AuthJson): UpstreamAuth {
  const accessToken = authJson.tokens?.access_token;
  const accountId = authJson.tokens?.account_id;

  if (!accessToken || !accountId) {
    throw new Error(
      "auth.json does not contain ChatGPT OAuth tokens (access_token/account_id)",
    );
  }

  return {
    accessToken,
    accountId,
  };
}

export async function resolveUpstreamAuth(
  config: AppConfig,
): Promise<UpstreamAuth> {
  let authJson = await readAuthJson(config.authJsonPath);

  if (tokenExpiresSoon(authJson.tokens?.access_token)) {
    authJson = await refreshAuthJson(config, config.authJsonPath, authJson);
  }

  return assertChatGptTokens(authJson);
}

export async function fetchWithAuthRetry(
  config: AppConfig,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const attempt = async (forceRefresh: boolean): Promise<Response> => {
    let authJson = await readAuthJson(config.authJsonPath);
    if (forceRefresh || tokenExpiresSoon(authJson.tokens?.access_token)) {
      authJson = await refreshAuthJson(config, config.authJsonPath, authJson);
    }

    const auth = assertChatGptTokens(authJson);
    const requestHeaders: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      requestHeaders[key] = value;
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          ...requestHeaders,
          authorization: `Bearer ${auth.accessToken}`,
          "chatgpt-account-id": auth.accountId,
          "user-agent": "codex-auth-openai-proxy/0.1.0",
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  const first = await attempt(false);
  if (first.status !== 401) {
    return first;
  }

  return attempt(true);
}
