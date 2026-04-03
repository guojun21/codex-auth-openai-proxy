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
  modelAliasPrefix: string;
  exposeRawUpstreamModels: boolean;
  proxyApiKey?: string;
  proxyApiKeys: string[];
  requestTimeoutMs: number;
  proxyLoggingEnabledDefault: boolean;
  proxyLogFilePath: string;
  proxyLogStatePath: string;
  proxyLogReadLimitMax: number;
  proxyLogFileMaxBytes: number;
  modelAliases: Array<{
    alias: string;
    upstreamModel: string;
    reasoningEffort?: string;
    reasoningSummary?: string;
    serviceTier?: string;
    contextWindow?: number;
    expose?: boolean;
  }>;
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

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseApiKeys(...sources: Array<string | undefined>): string[] {
  const keys = sources
    .flatMap((source) => (source ?? "").split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(keys)];
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
  const defaultArtifactsDir = path.resolve(process.cwd(), "var");
  const proxyApiKey = process.env.PROXY_API_KEY?.trim() || undefined;
  const proxyApiKeys = parseApiKeys(proxyApiKey, process.env.PROXY_API_KEYS);

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
    modelAliasPrefix: process.env.CODEX_MODEL_ALIAS_PREFIX ?? "codexproxy-",
    exposeRawUpstreamModels: envBoolean("CODEX_EXPOSE_RAW_UPSTREAM_MODELS", false),
    proxyApiKey,
    proxyApiKeys,
    requestTimeoutMs: envNumber("REQUEST_TIMEOUT_MS", 120_000),
    proxyLoggingEnabledDefault: envBoolean("PROXY_LOGGING_ENABLED", false),
    proxyLogFilePath: expandHome(
      process.env.PROXY_LOG_FILE_PATH ??
        path.join(defaultArtifactsDir, "request-debug.jsonl"),
    ),
    proxyLogStatePath: expandHome(
      process.env.PROXY_LOG_STATE_PATH ??
        path.join(defaultArtifactsDir, "logging-state.json"),
    ),
    proxyLogReadLimitMax: envNumber("PROXY_LOG_READ_LIMIT_MAX", 200),
    proxyLogFileMaxBytes: envNumber("PROXY_LOG_FILE_MAX_BYTES", 10 * 1024 * 1024),
    modelAliases: [
      {
        alias:
          process.env.CODEX_ALIAS_GPT54_LOW_FAST ?? "codexproxy-gpt-5.4-low-fast",
        upstreamModel: "gpt-5.4",
        reasoningEffort: "low",
        reasoningSummary: "none",
        serviceTier: "priority",
        contextWindow: 260_000,
      },
      {
        alias:
          process.env.CODEX_ALIAS_GPT54_MEDIUM_FAST ??
          "codexproxy-gpt-5.4-medium-fast",
        upstreamModel: "gpt-5.4",
        reasoningEffort: "medium",
        reasoningSummary: "none",
        serviceTier: "priority",
        contextWindow: 260_000,
      },
      {
        alias:
          process.env.CODEX_ALIAS_GPT54_HIGH_FAST ?? "codexproxy-gpt-5.4-high-fast",
        upstreamModel: "gpt-5.4",
        reasoningEffort: "high",
        reasoningSummary: "none",
        serviceTier: "priority",
        contextWindow: 260_000,
      },
      {
        alias:
          process.env.CODEX_ALIAS_GPT54_XHIGH_FAST ?? "codexproxy-gpt-5.4-xhigh-fast",
        upstreamModel: "gpt-5.4",
        reasoningEffort: "xhigh",
        reasoningSummary: "none",
        serviceTier: "priority",
        contextWindow: 260_000,
      },
      {
        alias: "codex-gpt-5-4-low-fast",
        upstreamModel: "gpt-5.4",
        reasoningEffort: "low",
        reasoningSummary: "none",
        serviceTier: "priority",
        contextWindow: 260_000,
        expose: false,
      },
      {
        alias: "codex-gpt-5-4-medium-fast",
        upstreamModel: "gpt-5.4",
        reasoningEffort: "medium",
        reasoningSummary: "none",
        serviceTier: "priority",
        contextWindow: 260_000,
        expose: false,
      },
      {
        alias: "codex-gpt-5-4-high-fast",
        upstreamModel: "gpt-5.4",
        reasoningEffort: "high",
        reasoningSummary: "none",
        serviceTier: "priority",
        contextWindow: 260_000,
        expose: false,
      },
      {
        alias: "codex-gpt-5-4-xhigh-fast",
        upstreamModel: "gpt-5.4",
        reasoningEffort: "xhigh",
        reasoningSummary: "none",
        serviceTier: "priority",
        contextWindow: 260_000,
        expose: false,
      },
      {
        alias:
          process.env.CODEX_ALIAS_GPT54_FAST_XHIGH ??
          "codex-gpt-5-4-fast-xhigh",
        upstreamModel: "gpt-5.4",
        reasoningEffort: "xhigh",
        reasoningSummary: "none",
        serviceTier: "priority",
        contextWindow: 260_000,
        expose: false,
      },
      {
        alias: process.env.CODEX_ALIAS_GPT54_COMPAT ?? "codex-gpt-5-4",
        upstreamModel: "gpt-5.4",
        reasoningEffort: "xhigh",
        reasoningSummary: "none",
        serviceTier: "priority",
        contextWindow: 260_000,
        expose: false,
      },
    ],
  };
}
