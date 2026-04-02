import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "./config.js";
import type { JsonMap } from "./openai.js";

export interface ProxyLogEntry {
  id: string;
  timestamp: string;
  kind: "request" | "control";
  action: string;
  enabled?: boolean;
  method?: string;
  path?: string;
  statusCode?: number;
  durationMs?: number;
  request?: JsonMap;
  upstream?: JsonMap;
  response?: JsonMap;
  error?: JsonMap;
}

interface LoggingState {
  enabled: boolean;
  updated_at: string;
}

function redactHeader(name: string, value: string): string {
  const lowered = name.toLowerCase();
  if (
    lowered === "authorization" ||
    lowered === "proxy-authorization" ||
    lowered === "cookie" ||
    lowered === "set-cookie" ||
    lowered === "chatgpt-account-id" ||
    lowered === "x-api-key"
  ) {
    return "[redacted]";
  }
  return value;
}

export function sanitizeHeaders(headers: Record<string, unknown>): JsonMap {
  const sanitized: JsonMap = {};
  for (const [name, rawValue] of Object.entries(headers)) {
    if (typeof rawValue === "string") {
      sanitized[name] = redactHeader(name, rawValue);
      continue;
    }
    if (Array.isArray(rawValue)) {
      sanitized[name] = rawValue.map((item) =>
        typeof item === "string" ? redactHeader(name, item) : String(item),
      );
      continue;
    }
    if (rawValue !== undefined) {
      sanitized[name] = String(rawValue);
    }
  }
  return sanitized;
}

export function sanitizeForLog(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value ?? null, (_key, nested) => {
      if (typeof nested === "bigint") {
        return nested.toString();
      }
      if (nested instanceof Error) {
        return {
          name: nested.name,
          message: nested.message,
          stack: nested.stack,
        };
      }
      if (Buffer.isBuffer(nested)) {
        return nested.toString("utf8");
      }
      if (nested instanceof Uint8Array) {
        return Buffer.from(nested).toString("utf8");
      }
      return nested;
    }),
  );
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

async function trimJsonlFileTail(filePath: string, maxBytes: number): Promise<void> {
  if (maxBytes <= 0) {
    return;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (fileStat.size <= maxBytes) {
    return;
  }

  const raw = await readFile(filePath);
  if (raw.length <= maxBytes) {
    return;
  }

  let trimmed = raw.subarray(raw.length - maxBytes);
  const firstNewline = trimmed.indexOf(0x0a);
  if (firstNewline >= 0 && firstNewline + 1 < trimmed.length) {
    trimmed = trimmed.subarray(firstNewline + 1);
  }

  if (trimmed.length === 0) {
    return;
  }

  await writeFile(filePath, trimmed);
}

export class ProxyLogger {
  #enabled: boolean;

  constructor(private readonly config: AppConfig) {
    this.#enabled = config.proxyLoggingEnabledDefault;
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.config.proxyLogFilePath), { recursive: true });
    await mkdir(path.dirname(this.config.proxyLogStatePath), { recursive: true });

    try {
      const raw = await readFile(this.config.proxyLogStatePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LoggingState>;
      if (typeof parsed.enabled === "boolean") {
        this.#enabled = parsed.enabled;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  isEnabled(): boolean {
    return this.#enabled;
  }

  status(): JsonMap {
    return {
      enabled: this.#enabled,
      log_file_path: this.config.proxyLogFilePath,
      state_file_path: this.config.proxyLogStatePath,
      read_limit_max: this.config.proxyLogReadLimitMax,
      log_file_max_bytes: this.config.proxyLogFileMaxBytes,
      detail_level:
        "full JSON request/response bodies, upstream payloads, SSE events, and errors are logged with secret headers redacted",
    };
  }

  async setEnabled(enabled: boolean): Promise<JsonMap> {
    this.#enabled = enabled;
    await writeJsonAtomic(this.config.proxyLogStatePath, {
      enabled,
      updated_at: new Date().toISOString(),
    } satisfies LoggingState);
    return this.status();
  }

  async record(
    entry: Omit<ProxyLogEntry, "id" | "timestamp"> &
      Partial<Pick<ProxyLogEntry, "id" | "timestamp">>,
    options?: { force?: boolean },
  ): Promise<void> {
    if (!this.#enabled && !options?.force) {
      return;
    }

    const fullEntry: ProxyLogEntry = {
      id: entry.id ?? randomUUID(),
      timestamp: entry.timestamp ?? new Date().toISOString(),
      ...entry,
    };

    await appendFile(
      this.config.proxyLogFilePath,
      `${JSON.stringify(sanitizeForLog(fullEntry))}\n`,
      "utf8",
    );
    await trimJsonlFileTail(this.config.proxyLogFilePath, this.config.proxyLogFileMaxBytes);
  }

  async list(limit: number): Promise<ProxyLogEntry[]> {
    const cappedLimit = Math.max(1, Math.min(limit, this.config.proxyLogReadLimitMax));

    try {
      const raw = await readFile(this.config.proxyLogFilePath, "utf8");
      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const entries: ProxyLogEntry[] = [];
      for (const line of lines.slice(-cappedLimit)) {
        try {
          entries.push(JSON.parse(line) as ProxyLogEntry);
        } catch {
          // Ignore malformed lines and keep returning the readable tail.
        }
      }
      return entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}
