import { resolveConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

function extractResponseText(payload: any): string {
  if (Array.isArray(payload?.output)) {
    for (const item of payload.output) {
      if (item?.type !== "message" || !Array.isArray(item.content)) {
        continue;
      }
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          return part.text;
        }
      }
    }
  }
  return "";
}

function extractChatStreamText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  let text = "";
  for (const line of lines) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") {
      continue;
    }
    try {
      const payload = JSON.parse(line.slice(6));
      const delta = payload?.choices?.[0]?.delta;
      if (typeof delta?.content === "string") {
        text += delta.content;
      }
    } catch {
      // Ignore malformed lines during smoke reconstruction.
    }
  }
  return text;
}

async function main() {
  const config = await resolveConfig();
  const app = await buildServer(config);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const health = await fetch(`${address}/health`);
    const healthJson = await health.json();

    const modelsResponse = await fetch(`${address}/v1/models`);
    const modelsJson = await modelsResponse.json();
    const model = process.env.LIVE_PROXY_MODEL ?? modelsJson.data?.[0]?.id ?? config.defaultModel;

    const chatResponse = await fetch(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: "Reply with exactly LIVE_CHAT_OK and nothing else.",
          },
        ],
      }),
    });
    const chatJson = await chatResponse.json();

    const responsesResponse = await fetch(`${address}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: "Reply with exactly LIVE_RESPONSES_OK and nothing else.",
      }),
    });
    const responsesJson = await responsesResponse.json();

    const chatStreamResponse = await fetch(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          {
            role: "user",
            content: "Reply with exactly LIVE_STREAM_CHAT_OK and nothing else.",
          },
        ],
      }),
    });
    const chatStreamText = await chatStreamResponse.text();
    const chatStreamReconstructed = extractChatStreamText(chatStreamText);

    const responsesStreamResponse = await fetch(`${address}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: true,
        input: "Reply with exactly LIVE_STREAM_RESPONSES_OK and nothing else.",
      }),
    });
    const responsesStreamText = await responsesStreamResponse.text();

    const summary = {
      health_ok: health.ok,
      account_id: healthJson.account_id,
      models_ok: modelsResponse.ok,
      model_count: Array.isArray(modelsJson.data) ? modelsJson.data.length : 0,
      selected_model: model,
      chat_ok: chatResponse.ok,
      chat_text: chatJson?.choices?.[0]?.message?.content ?? null,
      responses_ok: responsesResponse.ok,
      responses_text: extractResponseText(responsesJson),
      chat_stream_ok: chatStreamResponse.ok,
      chat_stream_has_done: chatStreamText.includes("data: [DONE]"),
      chat_stream_has_text: chatStreamReconstructed === "LIVE_STREAM_CHAT_OK",
      responses_stream_ok: responsesStreamResponse.ok,
      responses_stream_has_completed: responsesStreamText.includes(
        '"type":"response.completed"',
      ),
      responses_stream_has_text: responsesStreamText.includes(
        "LIVE_STREAM_RESPONSES_OK",
      ),
    };

    console.log(JSON.stringify(summary, null, 2));

    if (
      !summary.health_ok ||
      !summary.models_ok ||
      !summary.chat_ok ||
      !summary.responses_ok ||
      !summary.chat_stream_ok ||
      !summary.responses_stream_ok ||
      summary.chat_text !== "LIVE_CHAT_OK" ||
      summary.responses_text !== "LIVE_RESPONSES_OK" ||
      !summary.chat_stream_has_done ||
      !summary.chat_stream_has_text ||
      !summary.responses_stream_has_completed ||
      !summary.responses_stream_has_text
    ) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

await main();
