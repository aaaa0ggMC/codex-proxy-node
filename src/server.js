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
import { setSSEHeaders, writeSSEData, writeSSEDone } from "./sse.js";
import { usageReport, usageText, usageValue } from "./usage.js";
import { runAgent } from "./agent/loop.js";
import { note } from "./notes.js";

export class Server {
  #usageLock = Promise.resolve();

  constructor({
    provider,
    log,
    apiKey = "",
    webSearch = false,
    usageTTL = null,
    registry = null,
    maxTurns = 4,
    discardImages = 0,
    progress = false,
    keepaliveMs = 15_000,
  }) {
    this.provider = provider;
    this.log = log;
    this.apiKey = apiKey;
    this.webSearch = webSearch;
    this.usageTTL = usageTTL;
    this.registry = registry;
    this.maxTurns = maxTurns;
    this.discardImages = discardImages;
    this.progress = progress;
    this.keepaliveMs = keepaliveMs;
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
    const count = (chunk) => {
      if (typeof chunk === "string") bytes += Buffer.byteLength(chunk);
      else if (Buffer.isBuffer(chunk)) bytes += chunk.length;
      else if (chunk instanceof Uint8Array) bytes += chunk.byteLength;
    };
    // Node writes short bodies with res.end(body), which never touches res.write, so both need
    // wrapping for the byte count to match what actually went out.
    const write = res.write.bind(res);
    res.write = (chunk, ...rest) => {
      count(chunk);
      return write(chunk, ...rest);
    };
    const end = res.end.bind(res);
    res.end = (chunk, ...rest) => {
      count(chunk);
      return end(chunk, ...rest);
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
      const models = await this.provider.models(this.#signal(res));
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
    // Go through #agent so the non-streaming path gets the same loop settings as the streaming one.
    const { agent, stopKeepalive } = this.#agent(req, res, request);
    try {
      return await aggregateResponsesStream(agent, request);
    } finally {
      stopKeepalive();
    }
  }

  // upstreamEvents returns the provider's Responses events, turning a non-2xx response into an
  // error that still carries the upstream status so the handler can mirror it.
  async #upstreamEvents(request, signal) {
    return this.provider.events(request, signal);
  }

  #agent(req, res, request) {
    const signal = this.#signal(res);
    return {
      signal,
      ...this.#keepalive(res),
      agent: runAgent({
        stream: (payload, sig) => this.#upstreamEvents(payload, sig),
        request,
        registry: this.registry,
        signal,
        log: this.log,
        maxTurns: this.maxTurns,
        discardImages: this.discardImages,
      }),
    };
  }

  // A local tool can take seconds (rendering a PDF page, re-encoding a slide). Chat Completions has
  // no progress channel, so at minimum the socket has to stay busy or a client gives up and closes
  // the request. An SSE comment is the standard way to do that: every parser skips it.
  #keepalive(res) {
    if (this.keepaliveMs <= 0) return { stopKeepalive: () => {} };
    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write(": keepalive\n\n");
    }, this.keepaliveMs);
    timer.unref?.();
    return { stopKeepalive: () => clearInterval(timer) };
  }

  async #streamResponses(req, res, request) {
    const { agent, stopKeepalive } = this.#agent(req, res, request);

    // Same eager first pull as the chat path, so an upstream refusal stays an HTTP status.
    let step;
    try {
      step = await agent.next();
    } catch (err) {
      stopKeepalive();
      writeOpenAIError(res, err.status ?? 502, err.message);
      return;
    }

    setSSEHeaders(res);
    res.writeHead(200);
    try {
      while (!step.done) {
        if (res.writableEnded || res.destroyed) return;
        const event = step.value;
        if (event.type === "codex_proxy.tool_start") {
          step = await agent.next();
          continue;
        }
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        step = await agent.next();
      }
    } catch {
      res.end();
      return;
    } finally {
      stopKeepalive();
    }
    writeSSEDone(res);
    res.end();
  }

  async #streamChatCompletions(req, res, request, model, sendUsage) {
    const { agent, stopKeepalive } = this.#agent(req, res, request);

    // Pull the first event before writing anything, so an upstream refusal is still a plain HTTP
    // error instead of a half-written SSE stream.
    let step;
    try {
      step = await agent.next();
    } catch (err) {
      stopKeepalive();
      writeOpenAIError(res, err.status ?? 502, err.message);
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
      while (!step.done) {
        const event = step.value;
        if (res.writableEnded || res.destroyed) return;
        switch (event.type) {
          case "response.output_text.delta":
            sendChunk([openAIChatDeltaChoice({ content: stringValue(event.data, "delta") }, null)], null);
            break;
          case "codex_proxy.tool_start":
            // Reported as thinking rather than as answer text: a client renders it, and the marker
            // lets the same proxy strip it back out of the replayed history (see notes.js).
            sendChunk(
              [
                openAIChatDeltaChoice(
                  { reasoning_content: `<th>${note(`${stringValue(event.data, "name")} …`)}</th>` },
                  null,
                ),
              ],
              null,
            );
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
        step = await agent.next();
      }
    } catch {
      res.end();
      return;
    } finally {
      stopKeepalive();
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
