import { createHash, timingSafeEqual } from "node:crypto";
import { boolValue, defaultedString, randomHex, stringValue } from "./util.js";
import {
  aggregateResponsesStream,
  buildResponsesRequestFromChat,
  normalizeResponsesRequest,
} from "./compat.js";
import {
  chatCompletionFromAggregate,
  chatUsageFromResponsesUsage,
  openAIChatCompletionChunk,
  openAIChatDeltaChoice,
  openAIChatToolCallDelta,
  openAIErrorResponse,
  openAIModelsResponse,
} from "./schema.js";
import { readStreamEvents, setSSEHeaders, writeSSEData, writeSSEDone } from "./sse.js";
import { usageReport, usageText, usageValue } from "./usage.js";

export class Server {
  #usageLock = Promise.resolve();

  constructor({ codex, log, apiKey = "", webSearch = false, usageTTL = null }) {
    this.codex = codex;
    this.log = log;
    this.apiKey = apiKey;
    this.webSearch = webSearch;
    this.usageTTL = usageTTL;
    this.usageCache = null;
    this.usageCacheAt = 0;
  }

  // withUsageLock serialises the cached usage fetch; JS is single threaded, but the awaits in
  // between still allow two requests to overlap, which the Go version prevents with a mutex.
  async withUsageLock(fn) {
    const run = this.#usageLock.then(fn);
    this.#usageLock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  handler() {
    return (req, res) => {
      this.handle(req, res).catch((err) => {
        this.log.error("unhandled error", { error: err.message });
        if (!res.headersSent) writeOpenAIError(res, 500, err.message);
        else res.end();
      });
    };
  }

  async handle(req, res) {
    const startedAt = Date.now();
    const requestId = randomHex(4);
    const url = new URL(req.url, "http://localhost");
    const log = this.log.child({
      request_id: requestId,
      method: req.method,
      path: url.pathname,
      remote: req.socket.remoteAddress,
    });

    let bytes = 0;
    const write = res.write.bind(res);
    res.write = (chunk, ...rest) => {
      if (chunk != null) bytes += Buffer.byteLength(chunk);
      return write(chunk, ...rest);
    };

    log.info("request started");
    try {
      this.#applyUsageHeaders(res);
      if (!this.#authorized(req)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="codex-proxy"');
        writeOpenAIError(res, 401, "missing or invalid API key");
      } else {
        await this.#route(req, res, url);
      }
    } catch (err) {
      if (!res.headersSent) writeOpenAIError(res, 500, err.message);
      else res.end();
    } finally {
      log.info("request finished", {
        status: res.statusCode,
        bytes,
        duration: formatDuration(Date.now() - startedAt),
      });
    }
  }

  async #route(req, res, url) {
    const { method } = req;
    const path = url.pathname;
    if (method === "GET" && path === "/healthz") return writeJSON(res, 200, { ok: true });
    if (method === "GET" && path === "/v1/models") return this.#handleModels(req, res);
    if (method === "GET" && path === "/v1/usage") return this.#handleUsage(req, res, url);
    if (method === "POST" && path === "/v1/responses") return this.#handleResponses(req, res);
    if (method === "POST" && path === "/v1/chat/completions") return this.#handleChatCompletions(req, res);

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 page not found\n");
  }

  #authorized(req) {
    if (this.apiKey === "") return true;
    return validBearerToken(req.headers.authorization ?? "", this.apiKey);
  }

  // applyUsageHeaders labels every response with the last known quota. It never triggers a
  // fetch: a chat request must not wait on the usage endpoint.
  #applyUsageHeaders(res) {
    if (this.usageCache == null) return;
    const headers = [
      ["X-Codex-Usage-Remaining", "tightest"],
      ["X-Codex-Usage-5h", "five_hour"],
      ["X-Codex-Usage-Weekly", "weekly"],
    ];
    for (const [header, window] of headers) {
      const value = usageValue(this.usageCache, window);
      if (value != null) res.setHeader(header, String(value));
    }
  }

  // signal aborts the upstream request if the client goes away mid-stream.
  #signal(res) {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    return controller.signal;
  }

  async #handleModels(req, res) {
    try {
      const models = await this.codex.models(this.#signal(res));
      writeJSON(res, 200, openAIModelsResponse(models));
    } catch (err) {
      writeOpenAIError(res, 502, err.message);
    }
  }

  // GET /v1/usage reports the remaining Codex quota (the 5 hour window and the weekly one).
  //
  //	?format=json     full JSON report (default)
  //	?format=text     one line: "5h 100% · 7d 6%"
  //	?format=number   one number: remaining percent, tightest window by default
  //	?window=five_hour|weekly|tightest picks another one
  //
  // ?refresh=1 bypasses the cache.
  async #handleUsage(req, res, url) {
    const query = url.searchParams;
    let format = (query.get("format") ?? "").trim().toLowerCase();
    if (format === "") format = "json";
    const refresh = (query.get("refresh") ?? "") !== "";
    const window = (query.get("window") ?? "").trim().toLowerCase();

    const { report, error } = await usageReport(this, refresh, this.#signal(res));
    if (error != null && report == null) {
      writeOpenAIError(res, 502, error.message);
      return;
    }
    if (error != null) {
      this.log.warn("usage refresh failed; serving the last known report", { error: error.message });
    }

    res.setHeader("Cache-Control", "no-store");
    switch (format) {
      case "json":
        writeJSON(res, 200, report);
        break;
      case "text":
      case "plain":
        writeText(res, usageText(report));
        break;
      case "number":
      case "value":
      case "percent": {
        const value = usageValue(report, window);
        if (value == null) {
          writeOpenAIError(res, 502, `no usage window matches ${JSON.stringify(window)}`);
          break;
        }
        writeText(res, String(value));
        break;
      }
      default:
        writeOpenAIError(res, 400, `unsupported format ${JSON.stringify(format)}; use json, text or number`);
    }
  }

  async #handleResponses(req, res) {
    let raw;
    try {
      raw = await decodeJSONMap(req);
    } catch (err) {
      writeOpenAIError(res, 400, err.message);
      return;
    }

    let request;
    let stream;
    try {
      ({ request, stream } = normalizeResponsesRequest(raw, { webSearch: this.webSearch }));
    } catch (err) {
      writeOpenAIError(res, 400, err.message);
      return;
    }

    if (stream) {
      await this.#streamResponses(req, res, request);
      return;
    }
    try {
      const agg = await this.#aggregate(req, res, request);
      writeJSON(res, 200, serializeAggregate(agg));
    } catch (err) {
      writeOpenAIError(res, 502, err.message);
    }
  }

  async #handleChatCompletions(req, res) {
    let raw;
    try {
      raw = await decodeJSONMap(req);
    } catch (err) {
      writeOpenAIError(res, 400, err.message);
      return;
    }

    let request;
    let stream;
    try {
      ({ request, stream } = buildResponsesRequestFromChat(raw, { webSearch: this.webSearch }));
    } catch (err) {
      writeOpenAIError(res, 400, err.message);
      return;
    }

    const model = stringValue(raw, "model");
    if (stream) {
      await this.#streamChatCompletions(req, res, request, model, includeUsage(raw));
      return;
    }
    try {
      const agg = await this.#aggregate(req, res, request);
      writeJSON(res, 200, chatCompletionFromAggregate(agg, model));
    } catch (err) {
      writeOpenAIError(res, 502, err.message);
    }
  }

  async #aggregate(req, res, request) {
    const resp = await this.codex.streamResponses(request, this.#signal(res));
    if (!resp.ok) throw await upstreamError(resp);
    return aggregateResponsesStream(resp.body, request);
  }

  async #streamResponses(req, res, request) {
    let resp;
    try {
      resp = await this.codex.streamResponses(request, this.#signal(res));
    } catch (err) {
      writeOpenAIError(res, 502, err.message);
      return;
    }
    if (!resp.ok) {
      writeOpenAIError(res, resp.status, (await upstreamError(resp)).message);
      return;
    }

    setSSEHeaders(res);
    res.writeHead(200);
    try {
      for await (const chunk of resp.body) {
        if (res.writableEnded || res.destroyed) return;
        res.write(chunk);
      }
    } catch {
      res.end();
      return;
    }
    writeSSEDone(res);
    res.end();
  }

  async #streamChatCompletions(req, res, request, model, sendUsage) {
    let resp;
    try {
      resp = await this.codex.streamResponses(request, this.#signal(res));
    } catch (err) {
      writeOpenAIError(res, 502, err.message);
      return;
    }
    if (!resp.ok) {
      writeOpenAIError(res, resp.status, (await upstreamError(resp)).message);
      return;
    }

    setSSEHeaders(res);
    res.writeHead(200);

    const id = "chatcmpl-" + randomHex(16);
    const created = Math.floor(Date.now() / 1000);
    let finishReason = "stop";
    let usage = null;
    let toolIndex = 0;

    const sendChunk = (choices, chunkUsage) => {
      if (res.writableEnded || res.destroyed) return;
      writeSSEData(res, openAIChatCompletionChunk(id, model, created, choices, chunkUsage));
    };

    sendChunk([openAIChatDeltaChoice({ role: "assistant", content: "" }, null)], null);

    try {
      for await (const event of readStreamEvents(resp.body)) {
        if (res.writableEnded || res.destroyed) return;
        switch (event.type) {
          case "response.output_text.delta":
            sendChunk([openAIChatDeltaChoice({ content: stringValue(event.data, "delta") }, null)], null);
            break;
          case "response.output_text.annotation.added": {
            const annotation = event.data.annotation;
            if (annotation != null) {
              sendChunk([openAIChatDeltaChoice({ annotations: [annotation] }, null)], null);
            }
            break;
          }
          case "response.output_item.done": {
            const item = event.data.item;
            if (item == null || typeof item !== "object" || stringValue(item, "type") !== "function_call") {
              break;
            }
            finishReason = "tool_calls";
            const callId = defaultedString(item, "call_id", defaultedString(item, "id", "call_" + randomHex(8)));
            const args = defaultedString(item, "arguments", "{}");
            sendChunk(
              [openAIChatDeltaChoice(openAIChatToolCallDelta(toolIndex, callId, stringValue(item, "name"), args), null)],
              null,
            );
            toolIndex += 1;
            break;
          }
          case "response.completed": {
            const response = event.data.response;
            if (response != null && typeof response === "object" && response.usage != null) {
              usage = response.usage;
            }
            break;
          }
          default:
            break;
        }
      }
    } catch {
      res.end();
      return;
    }

    sendChunk([openAIChatDeltaChoice({}, finishReason)], null);
    if (sendUsage) sendChunk([], chatUsageFromResponsesUsage(usage));
    writeSSEDone(res);
    res.end();
  }
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(3)}s`;
}

export function validBearerToken(header, apiKey) {
  const index = header.indexOf(" ");
  if (index === -1) return false;
  if (header.slice(0, index).toLowerCase() !== "bearer") return false;
  const token = header.slice(index + 1).trim();
  if (token === "") return false;
  const tokenHash = createHash("sha256").update(token).digest();
  const apiKeyHash = createHash("sha256").update(apiKey).digest();
  return timingSafeEqual(tokenHash, apiKeyHash);
}

export async function decodeJSONMap(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`invalid JSON body: ${err.message}`);
  }
  if (parsed === null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid JSON body: expected a JSON object");
  }
  return parsed;
}

async function upstreamError(resp) {
  const body = await resp.text();
  let message = body.trim();
  try {
    const payload = JSON.parse(body);
    const detail = stringValue(payload, "detail");
    if (detail !== "") {
      message = detail;
    } else if (payload?.error != null && typeof payload.error === "object") {
      const inner = stringValue(payload.error, "message");
      if (inner !== "") message = inner;
    }
  } catch {
    // Keep the raw body as the message.
  }
  if (message === "") message = `${resp.status} ${resp.statusText}`.trim();
  return new Error(`Codex upstream returned HTTP ${resp.status}: ${message}`);
}

export function includeUsage(raw) {
  const options = raw.stream_options;
  return options != null && typeof options === "object" && boolValue(options, "include_usage");
}

// serializeAggregate drops the internal outputText accumulator that the Go struct marks
// `json:"-"` before the response goes out.
export function serializeAggregate(agg) {
  const { outputText, ...rest } = agg;
  void outputText;
  return rest;
}

export function writeText(res, body) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body + "\n");
}

export function writeJSON(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

export function writeOpenAIError(res, status, message) {
  if (res.headersSent) {
    res.end();
    return;
  }
  writeJSON(res, status, openAIErrorResponse(message));
}
