import { randomUUID } from "node:crypto";

import type { AppConfig } from "./config.js";

export type JsonMap = Record<string, unknown>;

function ensureText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeEffort(value: string): string {
  if (value === "fast") {
    return "low";
  }
  if (value === "balanced") {
    return "medium";
  }
  if (value === "deep") {
    return "high";
  }
  if (value === "max") {
    return "xhigh";
  }
  return value;
}

function normalizeReasoning(body: JsonMap): JsonMap | undefined {
  if (body.reasoning && typeof body.reasoning === "object") {
    const result = { ...(body.reasoning as JsonMap) };
    const effort = ensureText(result.effort);
    if (effort) {
      result.effort = normalizeEffort(effort);
    }
    return result;
  }

  const effort = ensureText(body.reasoning_effort) ?? ensureText(body.reasoningEffort);
  const summary = ensureText(body.reasoning_summary) ?? ensureText(body.reasoningSummary);
  if (!effort && !summary) {
    return undefined;
  }

  return {
    ...(effort ? { effort: normalizeEffort(effort) } : {}),
    ...(summary ? { summary } : {}),
  };
}

function normalizeServiceTier(body: JsonMap): string | undefined {
  return ensureText(body.service_tier) ?? ensureText(body.serviceTier) ?? undefined;
}

function mergeReasoning(
  defaults: JsonMap | undefined,
  reasoning: JsonMap | undefined,
): JsonMap | undefined {
  if (!defaults && !reasoning) {
    return undefined;
  }
  return {
    ...(defaults ?? {}),
    ...(reasoning ?? {}),
  };
}

interface ResolvedModelSelection {
  publicModel: string;
  upstreamModel: string;
  aliasApplied: boolean;
  defaultReasoning?: JsonMap;
  defaultServiceTier?: string;
}

function resolveRequestedModel(
  rawModel: unknown,
  config: AppConfig,
): ResolvedModelSelection {
  const requestedModel = ensureText(rawModel) ?? config.defaultModel;
  if (requestedModel === config.gpt54FastXhighAlias.alias) {
    return {
      publicModel: requestedModel,
      upstreamModel: config.gpt54FastXhighAlias.upstreamModel,
      aliasApplied: true,
      defaultReasoning: {
        effort: config.gpt54FastXhighAlias.reasoningEffort,
        summary: config.gpt54FastXhighAlias.reasoningSummary,
      },
      defaultServiceTier: config.gpt54FastXhighAlias.serviceTier,
    };
  }
  return {
    publicModel: requestedModel,
    upstreamModel: requestedModel,
    aliasApplied: false,
  };
}

function normalizeText(body: JsonMap): JsonMap | undefined {
  if (body.text && typeof body.text === "object") {
    return body.text as JsonMap;
  }

  const verbosity =
    ensureText(body.verbosity) ??
    ensureText(body.text_verbosity) ??
    ensureText(body.textVerbosity);
  if (!verbosity) {
    return undefined;
  }

  return { verbosity };
}

function normalizeInputTextContent(
  content: unknown,
): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as JsonMap;
    const type = ensureText(record.type);
    if (type === "input_text") {
      const text = ensureText(record.text);
      if (text) {
        parts.push({ type: "input_text", text });
      }
      continue;
    }
    if (type === "text") {
      const text = ensureText(record.text);
      if (text) {
        parts.push({ type: "input_text", text });
      }
      continue;
    }
    if (type === "image_url") {
      const imageUrl = record.image_url;
      if (typeof imageUrl === "string") {
        parts.push({ type: "input_image", image_url: imageUrl });
        continue;
      }
      if (imageUrl && typeof imageUrl === "object") {
        const url = ensureText((imageUrl as JsonMap).url);
        if (url) {
          const imagePart: JsonMap = { type: "input_image", image_url: url };
          const detail = ensureText((imageUrl as JsonMap).detail);
          if (detail) {
            imagePart.detail = detail;
          }
          parts.push(imagePart);
        }
      }
    }
  }

  return parts;
}

function buildInputMessage(
  role: string,
  content: unknown,
): Record<string, unknown> | null {
  const normalizedRole =
    role === "developer" || role === "system" || role === "assistant"
      ? role
      : role === "user"
        ? "user"
        : null;
  if (!normalizedRole) {
    return null;
  }

  const parts = normalizeInputTextContent(content);
  if (parts.length === 0) {
    return null;
  }

  return {
    type: "message",
    role: normalizedRole,
    content: parts,
  };
}

function extractInstructionTexts(messages: JsonMap[]): string {
  const blocks: string[] = [];

  for (const message of messages) {
    const role = ensureText(message.role);
    if (role !== "system" && role !== "developer") {
      continue;
    }
    const textParts = normalizeInputTextContent(message.content)
      .map((part) => ensureText(part.text))
      .filter((value): value is string => Boolean(value));
    if (textParts.length > 0) {
      blocks.push(`[${role}]\n${textParts.join("\n")}`);
    }
  }

  return blocks.join("\n\n");
}

function normalizeExplicitInput(explicitInput: unknown): unknown[] {
  if (typeof explicitInput === "string") {
    return [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: explicitInput }],
      },
    ];
  }

  if (explicitInput && typeof explicitInput === "object" && !Array.isArray(explicitInput)) {
    const role = ensureText((explicitInput as JsonMap).role);
    if (!role) {
      return [];
    }
    const message = buildInputMessage(role, (explicitInput as JsonMap).content);
    return message ? [message] : [];
  }

  if (!Array.isArray(explicitInput)) {
    return [];
  }

  return explicitInput
    .map((item) => {
      if (!item || typeof item !== "object") {
        return item;
      }
      const record = item as JsonMap;
      if (record.type === "message") {
        const role = ensureText(record.role) ?? "user";
        return buildInputMessage(role, record.content) ?? record;
      }
      const role = ensureText(record.role);
      if (role) {
        return buildInputMessage(role, record.content) ?? record;
      }
      return record;
    })
    .filter((item) => item !== null);
}

function extractMessageRecords(items: unknown[]): JsonMap[] {
  return items.filter((item): item is JsonMap => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const record = item as JsonMap;
    return record.type === "message" && typeof record.role === "string";
  });
}

export function buildUpstreamResponsesRequest(
  body: JsonMap,
  config: AppConfig,
): {
  upstreamBody: JsonMap;
  publicModel: string;
  aliasApplied: boolean;
} {
  const selection = resolveRequestedModel(body.model, config);
  const explicitInput = body.input;
  let normalizedInput: unknown = explicitInput;

  if (explicitInput !== undefined) {
    normalizedInput = normalizeExplicitInput(explicitInput);
  } else if (Array.isArray(body.messages)) {
    normalizedInput = (body.messages as unknown[])
      .map((message) =>
        message && typeof message === "object"
          ? buildInputMessage(
              ensureText((message as JsonMap).role) ?? "user",
              (message as JsonMap).content,
            )
          : null,
      )
      .filter(Boolean);
  } else {
    normalizedInput = [];
  }

  return {
    publicModel: selection.publicModel,
    aliasApplied: selection.aliasApplied,
    upstreamBody: {
      model: selection.upstreamModel,
    instructions: typeof body.instructions === "string" ? body.instructions : "",
    input: normalizedInput,
    tools: Array.isArray(body.tools) ? body.tools : [],
    tool_choice: body.tool_choice ?? "auto",
    parallel_tool_calls: Boolean(body.parallel_tool_calls),
    store: Boolean(body.store),
    stream: true,
    include: Array.isArray(body.include) ? body.include : [],
      reasoning: mergeReasoning(selection.defaultReasoning, normalizeReasoning(body)),
      service_tier: normalizeServiceTier(body) ?? selection.defaultServiceTier,
    text: normalizeText(body),
    },
  };
}

export function buildUpstreamChatRequest(
  body: JsonMap,
  config: AppConfig,
): {
  upstreamBody: JsonMap;
  publicModel: string;
  aliasApplied: boolean;
} {
  const selection = resolveRequestedModel(body.model, config);
  const messages = Array.isArray(body.messages)
    ? (body.messages.filter(
        (value): value is JsonMap => Boolean(value) && typeof value === "object",
      ) as JsonMap[])
    : [];

  const normalizedExplicitInput =
    body.input !== undefined ? normalizeExplicitInput(body.input) : [];
  const normalizedExplicitMessages = extractMessageRecords(normalizedExplicitInput);

  const instructionSource =
    normalizedExplicitMessages.length > 0 ? normalizedExplicitMessages : messages;
  const input =
    normalizedExplicitMessages.length > 0
      ? normalizedExplicitMessages
          .filter((message) => {
            const role = ensureText(message.role);
            return role === "user" || role === "assistant";
          })
      : messages
          .filter((message) => {
            const role = ensureText(message.role);
            return role === "user" || role === "assistant";
          })
          .map((message) =>
            buildInputMessage(ensureText(message.role) ?? "user", message.content),
          )
          .filter(Boolean);

  const explicitInstructions = ensureText(body.instructions);
  const extractedInstructions = extractInstructionTexts(instructionSource);
  const instructions = [explicitInstructions, extractedInstructions]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

  return {
    publicModel: selection.publicModel,
    aliasApplied: selection.aliasApplied,
    upstreamBody: {
      model: selection.upstreamModel,
      instructions,
      input,
      tools: Array.isArray(body.tools) ? body.tools : [],
      tool_choice: body.tool_choice ?? "auto",
      parallel_tool_calls: Boolean(body.parallel_tool_calls),
      store: false,
      stream: true,
      include: Array.isArray(body.include) ? body.include : [],
      reasoning: mergeReasoning(selection.defaultReasoning, normalizeReasoning(body)),
      service_tier: normalizeServiceTier(body) ?? selection.defaultServiceTier,
      text: normalizeText(body),
    },
  };
}

export interface ParsedUpstreamResponse {
  response: JsonMap | null;
  responseId: string;
  model: string;
  created: number;
  text: string;
  toolCalls: Array<{
    callId: string;
    name: string;
    arguments: string;
  }>;
}

export function parseUpstreamResponsePayload(events: Array<JsonMap | null>): ParsedUpstreamResponse {
  let latestResponse: JsonMap | null = null;
  let textFromDeltas = "";
  let textFromDone: string | null = null;
  const toolCalls = new Map<string, { callId: string; name: string; arguments: string }>();

  for (const event of events) {
    if (!event) {
      continue;
    }

    const type = ensureText(event.type);
    const response = event.response;
    if (response && typeof response === "object") {
      latestResponse = response as JsonMap;
    }

    if (type === "response.output_text.delta") {
      textFromDeltas += ensureText(event.delta) ?? "";
      continue;
    }

    if (type === "response.output_text.done") {
      textFromDone = ensureText(event.text);
      continue;
    }

    if (type === "response.output_item.done" && event.item && typeof event.item === "object") {
      const item = event.item as JsonMap;
      if (ensureText(item.type) === "function_call") {
        const callId = ensureText(item.call_id) ?? randomUUID();
        toolCalls.set(callId, {
          callId,
          name: ensureText(item.name) ?? "function",
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        });
      }
      if (ensureText(item.type) === "message" && !textFromDone && Array.isArray(item.content)) {
        const outputText = item.content
          .filter((part) => part && typeof part === "object")
          .map((part) =>
            ensureText((part as JsonMap).type) === "output_text"
              ? ensureText((part as JsonMap).text)
              : null,
          )
          .filter((value): value is string => Boolean(value))
          .join("");
        if (outputText) {
          textFromDone = outputText;
        }
      }
    }
  }

  if (!textFromDone && latestResponse && Array.isArray(latestResponse.output)) {
    const completedOutputText = latestResponse.output
      .filter((item) => item && typeof item === "object")
      .flatMap((item) => {
        const record = item as JsonMap;
        if (ensureText(record.type) !== "message" || !Array.isArray(record.content)) {
          return [];
        }
        return record.content
          .filter((part) => part && typeof part === "object")
          .map((part) =>
            ensureText((part as JsonMap).type) === "output_text"
              ? ensureText((part as JsonMap).text)
              : null,
          )
          .filter((value): value is string => Boolean(value));
      })
      .join("");
    if (completedOutputText) {
      textFromDone = completedOutputText;
    }
  }

  const responseId =
    ensureText(latestResponse?.id) ?? `resp_${randomUUID().replace(/-/g, "")}`;
  const model = ensureText(latestResponse?.model) ?? "unknown";
  const created =
    typeof latestResponse?.created_at === "number"
      ? (latestResponse.created_at as number)
      : Math.floor(Date.now() / 1000);

  return {
    response: latestResponse,
    responseId,
    model,
    created,
    text: textFromDone ?? textFromDeltas,
    toolCalls: [...toolCalls.values()],
  };
}

export function toModelsResponse(
  upstreamModels: Array<JsonMap>,
  config: AppConfig,
): JsonMap {
  const models = upstreamModels
    .filter((model) => {
      const visibility = ensureText(model.visibility);
      return visibility === null || visibility === "list";
    })
    .map((model) => ({
      id: ensureText(model.slug) ?? ensureText(model.id) ?? "unknown",
      object: "model",
      created: 0,
      owned_by: "openai",
    }));

  if (models.some((model) => model.id === config.gpt54FastXhighAlias.upstreamModel)) {
    models.unshift({
      id: config.gpt54FastXhighAlias.alias,
      object: "model",
      created: 0,
      owned_by: "codex-auth-openai-proxy",
    });
  }

  return {
    object: "list",
    data: models,
  };
}

export function toChatCompletionUsage(response: JsonMap | null): JsonMap | undefined {
  const usage = response?.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  return {
    prompt_tokens:
      typeof (usage as JsonMap).input_tokens === "number"
        ? (usage as JsonMap).input_tokens
        : 0,
    completion_tokens:
      typeof (usage as JsonMap).output_tokens === "number"
        ? (usage as JsonMap).output_tokens
        : 0,
    total_tokens:
      typeof (usage as JsonMap).total_tokens === "number"
        ? (usage as JsonMap).total_tokens
        : 0,
  };
}

export function toChatCompletionResponse(parsed: ParsedUpstreamResponse): JsonMap {
  return {
    id: parsed.responseId,
    object: "chat.completion",
    created: parsed.created,
    model: parsed.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: parsed.toolCalls.length > 0 ? null : parsed.text,
          ...(parsed.toolCalls.length > 0
            ? {
                tool_calls: parsed.toolCalls.map((call) => ({
                  id: call.callId,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: call.arguments,
                  },
                })),
              }
            : {}),
        },
        finish_reason: parsed.toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: toChatCompletionUsage(parsed.response),
  };
}

export function buildFallbackResponsesObject(
  parsed: ParsedUpstreamResponse,
): JsonMap {
  return {
    id: parsed.responseId,
    object: "response",
    created_at: parsed.created,
    model: parsed.model,
    status: "completed",
    output: [
      {
        id: `msg_${randomUUID().replace(/-/g, "")}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: parsed.text }],
      },
    ],
  };
}
