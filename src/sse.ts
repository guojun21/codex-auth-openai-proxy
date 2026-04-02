export interface SseFrame {
  event: string;
  data: string;
  raw: string;
}

function parseSseFrame(raw: string): SseFrame {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  return {
    event,
    data: dataLines.join("\n"),
    raw,
  };
}

export async function* iterateSseFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const takeFrame = (): SseFrame | null => {
    const crlfBoundary = buffer.indexOf("\r\n\r\n");
    const lfBoundary = buffer.indexOf("\n\n");
    const boundary =
      crlfBoundary >= 0 && (lfBoundary < 0 || crlfBoundary < lfBoundary)
        ? crlfBoundary
        : lfBoundary;

    if (boundary < 0) {
      return null;
    }

    const separatorLength =
      boundary === crlfBoundary && crlfBoundary >= 0 ? 4 : 2;
    const raw = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + separatorLength);
    return raw.trim() ? parseSseFrame(raw) : null;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let frame = takeFrame();
    while (frame) {
      yield frame;
      frame = takeFrame();
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    yield parseSseFrame(buffer);
  }
}

export async function collectSseFrames(
  stream: ReadableStream<Uint8Array>,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of iterateSseFrames(stream)) {
    frames.push(frame);
  }
  return frames;
}

export function safeParseSseJson(frame: SseFrame): Record<string, unknown> | null {
  try {
    return JSON.parse(frame.data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function formatSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
