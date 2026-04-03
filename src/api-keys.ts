import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredApiKey {
  id: string;
  key: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

interface StoredApiKeyState {
  keys?: StoredApiKey[];
}

export interface ApiKeyMatch {
  source: "env" | "generated";
  id: string;
}

export interface ApiKeyListEntry {
  id: string;
  source: "env" | "generated";
  label: string | null;
  created_at: string | null;
  last_used_at: string | null;
  masked_key: string;
}

function maskKey(key: string): string {
  if (key.length <= 8) {
    return `${key.slice(0, 2)}***${key.slice(-2)}`;
  }
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export class ProxyApiKeyStore {
  private generatedKeys: StoredApiKey[] = [];

  constructor(
    private readonly statePath: string,
    private readonly configuredKeys: string[],
  ) {}

  async init(): Promise<void> {
    this.generatedKeys = await this.readState();
  }

  isEnabled(): boolean {
    return this.configuredKeys.length > 0 || this.generatedKeys.length > 0;
  }

  count(): number {
    return this.configuredKeys.length + this.generatedKeys.length;
  }

  list(): ApiKeyListEntry[] {
    const configured = this.configuredKeys.map((key, index) => ({
      id: `env-${index + 1}`,
      source: "env" as const,
      label: "configured via environment",
      created_at: null,
      last_used_at: null,
      masked_key: maskKey(key),
    }));

    const generated = this.generatedKeys.map((entry) => ({
      id: entry.id,
      source: "generated" as const,
      label: entry.label,
      created_at: entry.created_at,
      last_used_at: entry.last_used_at,
      masked_key: maskKey(entry.key),
    }));

    return [...configured, ...generated];
  }

  find(token: string): ApiKeyMatch | null {
    const configuredIndex = this.configuredKeys.indexOf(token);
    if (configuredIndex >= 0) {
      return {
        source: "env",
        id: `env-${configuredIndex + 1}`,
      };
    }

    const generated = this.generatedKeys.find((entry) => entry.key === token);
    if (!generated) {
      return null;
    }

    return {
      source: "generated",
      id: generated.id,
    };
  }

  async markUsed(token: string): Promise<void> {
    const index = this.generatedKeys.findIndex((entry) => entry.key === token);
    if (index < 0) {
      return;
    }

    this.generatedKeys[index] = {
      ...this.generatedKeys[index],
      last_used_at: new Date().toISOString(),
    };
    await this.writeState();
  }

  async create(label?: string): Promise<StoredApiKey> {
    const entry: StoredApiKey = {
      id: `key_${randomUUID().replace(/-/g, "")}`,
      key: randomBytes(24).toString("base64url"),
      label: label?.trim() || null,
      created_at: new Date().toISOString(),
      last_used_at: null,
    };

    this.generatedKeys.push(entry);
    await this.writeState();
    return entry;
  }

  private async readState(): Promise<StoredApiKey[]> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as StoredApiKeyState;
      return Array.isArray(parsed.keys)
        ? parsed.keys.filter(
            (entry): entry is StoredApiKey =>
              Boolean(entry)
              && typeof entry === "object"
              && typeof (entry as StoredApiKey).id === "string"
              && typeof (entry as StoredApiKey).key === "string",
          )
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async writeState(): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const tmpPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(
      tmpPath,
      `${JSON.stringify({ keys: this.generatedKeys }, null, 2)}\n`,
      "utf8",
    );
    await rename(tmpPath, this.statePath);
  }
}
