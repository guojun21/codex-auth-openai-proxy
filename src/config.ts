import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AppConfig {
  host: string;
  port: number;
  authJsonPath: string;
  upstreamBaseUrl: string;
  refreshUrl: string;
  clientVersion: string;
  defaultModel: string;
  proxyApiKey?: string;
  requestTimeoutMs: number;
}

const DEFAULT_CLIENT_VERSION = "0.111.0";

export function expandHome(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function detectClientVersion(): Promise<string> {
  if (process.env.CODEX_CLIENT_VERSION) {
    return process.env.CODEX_CLIENT_VERSION;
  }

  try {
    const { stdout, stderr } = await execFileAsync("codex", ["--version"]);
    const text = `${stdout}\n${stderr}`;
    const match = text.match(/codex-cli\s+([0-9A-Za-z.\-]+)/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Fall through to the baked-in version used during local investigation.
  }

  return DEFAULT_CLIENT_VERSION;
}

export async function resolveConfig(): Promise<AppConfig> {
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: envNumber("PORT", 8787),
    authJsonPath: expandHome(
      process.env.CODEX_AUTH_JSON_PATH ?? "~/.codex/auth.json",
    ),
    upstreamBaseUrl:
      process.env.CODEX_UPSTREAM_BASE_URL ??
      "https://chatgpt.com/backend-api/codex",
    refreshUrl:
      process.env.CODEX_REFRESH_URL ?? "https://auth.openai.com/oauth/token",
    clientVersion: await detectClientVersion(),
    defaultModel: process.env.CODEX_DEFAULT_MODEL ?? "gpt-5.4",
    proxyApiKey: process.env.PROXY_API_KEY,
    requestTimeoutMs: envNumber("REQUEST_TIMEOUT_MS", 120_000),
  };
}
