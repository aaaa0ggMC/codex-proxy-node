// Server-sent events: the Codex backend streams them, and the proxy re-emits them.
// The reader mirrors the Go implementation so both proxies agree on multi-line `data:`
// handling and on blank-line dispatch.

const decoder = new TextDecoder();

function* dispatch(eventName, data) {
  const trimmed = data.trim();
  if (trimmed === "" || trimmed === "[DONE]") return;
  const parsed = JSON.parse(trimmed);
  const type = eventName || (typeof parsed.type === "string" ? parsed.type : "");
  yield { type, data: parsed };
}

// readStreamEvents turns a fetch() body into an async iterator of { type, data }.
export async function* readStreamEvents(body) {
  let eventName = "";
  let dataLines = [];
  let buffer = "";

  const consumeLine = function* (rawLine) {
    let line = rawLine;
    if (line.endsWith("\r")) line = line.slice(0, -1);

    if (line === "") {
      if (dataLines.length > 0) {
        yield* dispatch(eventName, dataLines.join("\n"));
        dataLines = [];
      }
      eventName = "";
    } else if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      yield* consumeLine(line);
    }
  }

  buffer += decoder.decode();
  if (buffer !== "") yield* consumeLine(buffer);
  yield* consumeLine("");
}

export function setSSEHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}

export function writeSSEData(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

export function writeSSEDone(res) {
  res.write("data: [DONE]\n\n");
}
