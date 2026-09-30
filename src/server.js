import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
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
  chatAnnotationFromResponses,
} from "./schema.js";
import { setSSEHeaders, writeSSEData, writeSSEDone } from "./sse.js";
import { usageReport, usageText, usageValue } from "./usage.js";
import { runAgent } from "./agent/loop.js";
import { restoreResponseInput, transformEvents, withLeadingInjection } from "./transforms.js";
import { note } from "./notes.js";
import { checkpoint } from "./checkpoints.js";
import { handleAdmin } from "./admin.js";
import { applyInputSwitches, applyModuleSwitches, enabledModules } from "./modules.js";
import { ContextStore } from "./context-store.js";
import { ConversationContext, carryContext, CONTEXT_TOOL } from "./context.js";
import { TOOL_PREFIX } from "./agent/names.js";
import { attachOnce } from "./sdk.js";
import { getImage } from "./media.js";

// The per-request plugin gate: what the conversation switched off, what it switched back on, and the
// raw switches (a plugin may want to see them).
const NO_MODULES = { disabled: new Set(), include: new Set(), switches: [], origin: "" };

export class Server {
  #usageLock = Promise.resolve();

  constructor({
    provider,
    log,
    apiKey = "",
    webSearch = false,
    usageTTL = null,
    registry = null,
    maxTurns = 256,
    discardImages = 0,
    progress = false,
    keepaliveMs = 15_000,
    pluginStateFile = "",
    contextStore = new ContextStore(),
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
    this.pluginStateFile = pluginStateFile;
    this.contextStore = contextStore;
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
      // The plugin admin page is served without a key only when no key is configured, so a
      // key-protected deployment does not accidentally expose a control plane.
      if (this.registry != null && this.apiKey === "" && this.pluginStateFile !== "") {
        if (await handleAdmin(req, res, url, {
          registry: this.registry,
          stateFile: this.pluginStateFile,
          log: this.log,
        })) {
          return;
        }
      }
      // A rendered image is fetched by the client's markdown renderer, which sends no bearer
      // token; it is content the user was already shown, so it is served without the key.
      if (req.method === "GET" && url.pathname.startsWith("/media/")) {
        this.#handleMedia(res, url.pathname.slice("/media/".length));
        return;
      }
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
    if (method === "GET" && path === "/healthz") return this.#handleHealth(res);
    if (method === "GET" && path === "/v1/models") return this.#handleModels(req, res);
    if (method === "GET" && path === "/v1/usage") return this.#handleUsage(req, res, url);
    if (method === "POST" && path === "/v1/responses") return this.#handleResponses(req, res);
    if (method === "POST" && path === "/v1/chat/completions") return this.#handleChatCompletions(req, res);

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 page not found\n");
  }

  // Health is also the discovery hook: a supervisor (MCPHub) reads this payload to find the plugin
  // console and link to it. The console is served without a key, so a key-protected proxy does not
  // advertise one; anything else keeps the plain liveness answer.
  #handleHealth(res) {
    const body = { ok: true };
    if (this.registry != null && this.apiKey === "" && this.pluginStateFile !== "") {
      body.ui = "/admin/plugins";
      body.uiLabel = "Plugins";
    }
    writeJSON(res, 200, body);
  }

  #handleMedia(res, id) {
    const image = getImage(decodeURIComponent(String(id ?? "")));
    if (image == null) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 image not found\n");
      return;
    }
    res.writeHead(200, { "Content-Type": image.mime, "Cache-Control": "private, max-age=300" });
    res.end(image.bytes);
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
      ({ request, stream } = normalizeResponsesRequest(raw, {
        webSearch: this.webSearch,
        searchAliases: await this.#searchAliases(raw.model, res),
      }));
    } catch (err) {
      writeOpenAIError(res, 400, err.message);
      return;
    }

    // Same switch, expressed against the Responses input shape.
    const parsed = applyInputSwitches(request.input, this.registry?.pluginNames() ?? []);
    const modules = {
      disabled: parsed.disabled,
      switches: parsed.switches,
      include: enabledModules(parsed.switches, this.registry?.pluginNames() ?? []),
      origin: originOf(req),
    };
    if (modules.disabled.size > 0) {
      this.log.info("modules disabled by switch", { modules: [...modules.disabled] });
    }
    if (modules.include.size > 0) {
      this.log.info("modules switched on by tag", { modules: [...modules.include] });
    }
    // A rendered answer is replayed as an image; put the source back before the provider sees it.
    restoreResponseInput(request.input, {
      registry: this.registry,
      disabledPlugins: modules.disabled,
      include: modules.include,
    });

    if (stream) {
      await this.#streamResponses(req, res, request, modules);
      return;
    }
    try {
      const agg = await this.#aggregate(req, res, request, modules);
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

    // Chat attachments arrive inline, so turn them into open documents before translation. This
    // has to happen per request because the client re-sends the file with every turn.
    const ingested = [];
    try {
      await this.#ingestAttachments(raw, ingested);
    } catch (err) {
      writeOpenAIError(res, 400, err.message);
      return;
    }

    // <disable_module> in the first user message turns a module off for this conversation. The tag
    // is stripped either way, so the upstream model never sees the control syntax.
    const parsed = applyModuleSwitches(raw.messages, this.registry?.pluginNames() ?? []);
    const modules = {
      disabled: parsed.disabled,
      switches: parsed.switches,
      include: enabledModules(parsed.switches, this.registry?.pluginNames() ?? []),
      ingested,
      origin: originOf(req),
    };
    if (modules.disabled.size > 0) {
      this.log.info("modules disabled by switch", { modules: [...modules.disabled] });
    }
    if (modules.include.size > 0) {
      this.log.info("modules switched on by tag", { modules: [...modules.include] });
    }

    let request;
    let stream;
    try {
      ({ request, stream } = buildResponsesRequestFromChat(raw, {
        webSearch: this.webSearch,
        searchAliases: await this.#searchAliases(raw.model, res),
        restoreText: (text, extra) =>
          this.registry?.restore(text, { exclude: modules.disabled, include: modules.include, ...extra }) ?? text,
      }));
    } catch (err) {
      writeOpenAIError(res, 400, err.message);
      return;
    }

    const model = stringValue(raw, "model");
    if (stream) {
      await this.#streamChatCompletions(req, res, request, model, includeUsage(raw), modules);
      return;
    }
    try {
      const agg = await this.#aggregate(req, res, request, modules);
      writeJSON(res, 200, chatCompletionFromAggregate(agg, model));
    } catch (err) {
      writeOpenAIError(res, 502, err.message);
    }
  }

  // Attachments are inline base64 in a "file" part. Each one is handed to the plugin registry and
  // replaced by a text descriptor, so the translator never sees a shape the provider cannot take.
  async #ingestAttachments(raw, ingested) {
    if (this.registry == null || !Array.isArray(raw.messages)) return;
    // The shape of what arrived, sizes only: enough to see where a prompt's tokens come from
    // without putting message content in the log.
    // Names only. A capability the client claims but the provider never sees shows up here: the
    // search toggle, for instance, is only real if the request actually carries it.
    this.log.info("chat request shape", {
      top_level: Object.keys(raw).sort().join(","),
      web_search_options: raw.web_search_options === undefined ? "absent" : JSON.stringify(raw.web_search_options),
      client_tools: Array.isArray(raw.tools) ? raw.tools.map((tool) => stringValue(tool, "type") || stringValue(tool, "name") || "?").join(",") : "absent",
      messages: raw.messages.length,
      shape: raw.messages
        .map((message) => {
          const role = stringValue(message, "role") || "?";
          if (!Array.isArray(message?.content)) return `${role}:text(${String(message?.content ?? "").length})`;
          return `${role}:[${message.content
            .map((part) => {
              const type = stringValue(part, "type") || "?";
              const body = part?.file ?? part;
              const size =
                typeof body?.text === "string"
                  ? body.text.length
                  : typeof body?.file_data === "string"
                    ? body.file_data.length
                    : typeof part?.image_url === "string"
                      ? part.image_url.length
                      : part?.image_url?.url
                        ? String(part.image_url.url).length
                        : 0;
              return `${type}(${size})`;
            })
            .join("+")}]`;
        })
        .join(" "),
    });
    for (const message of raw.messages) {
      if (!Array.isArray(message?.content)) continue;
      for (let index = 0; index < message.content.length; index++) {
        const part = message.content[index];
        if (part == null || typeof part !== "object" || part.type !== "file") {
          // Diagnostics for attachment shapes we do not recognise yet: names only, never values.
          if (part != null && typeof part === "object" && part.type !== "text" && part.type !== "image_url") {
            this.log.info("unhandled content part", {
              part_type: part.type,
              keys: Object.keys(part).join(","),
              file_keys: part.file != null && typeof part.file === "object" ? Object.keys(part.file).join(",") : "",
            });
          }
          continue;
        }
        const file = part.file ?? part;
        const filename = file.filename ?? "attachment";
        const inline = typeof file.file_data === "string" ? file.file_data : "";
        const comma = inline.indexOf(",");
        const data = inline.startsWith("data:") && comma !== -1 ? inline.slice(comma + 1) : "";
        const descriptor = await this.registry.ingest({ filename, data });
        if (descriptor != null) ingested.push({ filename, output: descriptor });
        message.content[index] = {
          type: "text",
          text:
            descriptor ??
            `[attachment ${filename} could not be read: only inline file_data for .pdf and .pptx is supported]`,
        };
      }
      // Some clients do not attach the bytes at all: they mention the file as a URL or a path
      // inside the text. Fetching that reference is what makes "look at this deck" work for them.
      await this.#ingestReferences(message, ingested);
    }
  }

  async #ingestReferences(message, ingested) {
    const additions = [];
    for (const part of message.content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      for (const match of part.text.matchAll(/https?:\/\/[^\s<>"')]+\.(?:pdf|pptx)|\/[^\s<>"')]+\.(?:pdf|pptx)/gi)) {
        const reference = match[0];
        try {
          const bytes = await this.#readReference(reference);
          if (bytes == null) continue;
          const descriptor = await this.registry.ingest({
            filename: path.basename(reference),
            data: bytes.toString("base64"),
          });
          if (descriptor != null) {
            additions.push({ type: "text", text: descriptor });
            ingested.push({ filename: reference, output: descriptor });
          }
        } catch (err) {
          this.log.warn("attachment reference could not be read", { reference, error: err.message });
        }
      }
    }
    if (additions.length > 0) message.content.push(...additions);
  }

  // Only the two extensions the docs plugin understands, and never more than a sane attachment
  // size, so a stray URL in a message cannot make the proxy download something huge.
  async #readReference(reference) {
    if (/^https?:/i.test(reference)) {
      const resp = await fetch(reference, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) return null;
      const length = Number(resp.headers.get("content-length") ?? 0);
      if (length > 64 * 1024 * 1024) throw new Error(`attachment is too large (${length} bytes)`);
      return Buffer.from(await resp.arrayBuffer());
    }
    try {
      return await readFile(reference);
    } catch (err) {
      this.log.info("attachment reference is not on this filesystem", { reference, error: err.code });
      return null;
    }
  }

  async #aggregate(req, res, request, modules = NO_MODULES) {
    // Go through #agent so the non-streaming path gets the same loop settings as the streaming one.
    const { agent, stopKeepalive } = await this.#agent(req, res, request, modules);
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

  // Whether a -search model id should actually turn search on, asked of whichever provider owns
  // the model. Kept per request: a shared flag would cross wires between concurrent requests.
  async #searchAliases(model, res) {
    if (typeof this.provider?.supportsSearchAliases !== "function") return false;
    return this.provider.supportsSearchAliases(model, this.#signal(res));
  }

  async #agent(req, res, request, modules = NO_MODULES) {
    const signal = this.#signal(res);
    const context = this.contextStore == null ? null : new ConversationContext(this.contextStore);
    if (context != null) request.input = await context.restore(request.input ?? []);
    if (context != null) {
      for (const attachment of modules.ingested ?? []) {
        await context.record(`${TOOL_PREFIX}_attachment_ingest`, JSON.stringify({ filename: attachment.filename }), attachment.output);
      }
    }
    // Explicit activation belongs to the core, not to a helper plugin or a special lore field.
    // Definitions, instructions and transforms use the same gate below.
    const activated = attachOnce(request.input, [...modules.include]
      .filter((name) => !modules.disabled.has(name))
      .map((name) => ({ tag: "plugin-inject", name, body: this.registry?.reference(name) ?? "" })))
      ?? { append: [], carried: [] };
    if (activated.append.length > 0) request.input = [...request.input, ...activated.append];
    // A plugin may contribute tail context (a mention activating a lorebook entry, say). It is a
    // pure function of the input, so appending it at the tail keeps the cached prefix intact, and
    // the notes ride the thinking channel so the client's history records what the model was given.
    const { append, notes, carried } = this.registry?.contribute?.(request, {
      exclude: modules.disabled,
      include: modules.include,
      switches: modules.switches,
    }) ?? { append: [], notes: [], carried: [] };
    if (append.length > 0) request.input = [...(request.input ?? []), ...append];
    if (context != null) {
      for (const message of append) {
        const content = message.content ?? message.output ?? "";
        const output = Array.isArray(content)
          ? content.map((part) => ["text", "output_text"].includes(part?.type) ? { ...part, type: "input_text" } : part)
          : typeof content === "string" ? content : JSON.stringify(content);
        await context.record(CONTEXT_TOOL, '{"note":"plugin contribution"}', output);
      }
    }

    const streamed = transformEvents(
      runAgent({
        stream: (payload, sig) => this.#upstreamEvents(payload, sig),
        request,
        registry: this.registry,
        signal,
        log: this.log,
        maxTurns: this.maxTurns,
        discardImages: this.discardImages,
        disabledPlugins: [...modules.disabled],
        includedPlugins: [...modules.include],
        context,
      }),
      { registry: this.registry, disabledPlugins: modules.disabled, include: modules.include, origin: modules.origin ?? "" },
    );
    const allCarried = [...activated.carried, ...carried];
    const injected = notes.length > 0 || allCarried.length > 0 ? withLeadingInjection({ notes, carried: allCarried }, streamed) : streamed;
    const agent = context == null ? injected : carryContext(injected, context);
    return { signal, ...this.#keepalive(res), agent };
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

  async #streamResponses(req, res, request, modules = NO_MODULES) {
    const { agent, stopKeepalive } = await this.#agent(req, res, request, modules);

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
        if (event.type === "codex_proxy.progress") {
          // A running tool's own progress, shown in thinking and stripped on replay (<ignore>).
          const text = stringValue(event.data, "text");
          if (text !== "") {
            res.write(`event: response.reasoning_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_text.delta", delta: note(text) })}\n\n`);
          }
          step = await agent.next();
          continue;
        }
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        step = await agent.next();
      }
    } catch (err) {
      // Headers are already out, so the failure cannot become an HTTP status; say so in-band
      // instead of leaving the client with a silently truncated stream.
      this.log.error("responses stream failed", { error: err.message, status: err.status });
      res.write(
        `event: response.failed\ndata: ${JSON.stringify({
          type: "response.failed",
          response: { id: null, status: "failed", error: { message: err.message } },
        })}\n\n`,
      );
      writeSSEDone(res);
      res.end();
      return;
    } finally {
      stopKeepalive();
    }
    writeSSEDone(res);
    res.end();
  }

  async #streamChatCompletions(req, res, request, model, sendUsage, modules = NO_MODULES) {
    const { agent, stopKeepalive } = await this.#agent(req, res, request, modules);

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
    const streamedReasoning = new Map();
    let unkeyedReasoning = "";
    const reasoningKey = (data) => data?.item_id ?? data?.item?.id
      ?? (Number.isInteger(data?.output_index) ? `index:${data.output_index}` : null);

    const sendChunk = (choices, chunkUsage) => {
      if (res.writableEnded || res.destroyed) return;
      writeSSEData(res, openAIChatCompletionChunk(id, model, created, choices, chunkUsage));
    };

    sendChunk([openAIChatDeltaChoice({ role: "assistant", content: "" }, null)], null);

    // Whether a citation ever reached us is otherwise invisible: a missing annotation in the client
    // could equally be the provider never sending one or us dropping it.
    const eventTypes = new Map();
    const tally = (type) => eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
    // Search numbers are ours, not the backend's: output_index counts every output item, so using
    // it directly makes two searches look like #1 and #3 and invites a hunt for missing ones.
    const searchNumbers = new Map();
    const searchNumber = (event) => {
      const key = event.data?.item_id ?? `#${event.data?.output_index ?? 0}`;
      if (!searchNumbers.has(key)) searchNumbers.set(key, searchNumbers.size + 1);
      return searchNumbers.get(key);
    };

    // Everything the client should fold away goes inside one <th>: the model's own thinking as
    // <mth>, our progress notes as <ignore>. The block is opened lazily and closed as soon as
    // real answer text starts, so the answer never ends up inside a thinking block.
    let reasoningOpen = false;
    const openReasoning = () => {
      if (reasoningOpen) return;
      reasoningOpen = true;
      sendChunk([openAIChatDeltaChoice({ reasoning_content: "<th><mth>" }, null)], null);
    };
    const closeReasoning = () => {
      if (!reasoningOpen) return;
      reasoningOpen = false;
      sendChunk([openAIChatDeltaChoice({ reasoning_content: "</mth></th>" }, null)], null);
    };

    try {
      while (!step.done) {
        const event = step.value;
        if (res.writableEnded || res.destroyed) return;
        // A hosted search is otherwise invisible downstream: the client sees a pause and nothing
        // else. The phases go out on the reasoning channel, inside <ignore>, because they are
        // moment-to-moment progress rather than something worth replaying.
        if (typeof event.type === "string") tally(event.type);
        if (typeof event.type === "string" && event.type.startsWith("response.web_search_call.")) {
          openReasoning();
          const phase = event.type.slice("response.web_search_call.".length);
          // Labelled so serial and interleaved searches are distinguishable, numbered so the
          // sequence reads 1, 2, 3.
          sendChunk(
            [
              openAIChatDeltaChoice(
                { reasoning_content: note(`web search ${searchNumber(event)}: ${phase}`) },
                null,
              ),
            ],
            null,
          );
          step = await agent.next();
          continue;
        }
        switch (event.type) {
          case "response.output_text.delta":
            closeReasoning();
            sendChunk([openAIChatDeltaChoice({ content: stringValue(event.data, "delta") }, null)], null);
            break;
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta": {
            const delta = stringValue(event.data, "delta");
            const key = reasoningKey(event.data);
            if (key == null) unkeyedReasoning += delta;
            else streamedReasoning.set(key, (streamedReasoning.get(key) ?? "") + delta);
            openReasoning();
            sendChunk(
              [openAIChatDeltaChoice({ reasoning_content: delta }, null)],
              null,
            );
            break;
          }
          case "codex_proxy.checkpoint":
            // Content, not bookkeeping: inside the folded block but outside <ignore>, so it is not
            // stripped and the client keeps it for us.
            openReasoning();
            for (const block of event.data.blocks ?? []) {
              sendChunk([openAIChatDeltaChoice({ reasoning_content: `\n${checkpoint(block)}\n` }, null)], null);
            }
            break;
          case "codex_proxy.progress":
            // A slow tool (LibreOffice, a PDF page) reports progress as it runs.
            openReasoning();
            sendChunk(
              [openAIChatDeltaChoice({ reasoning_content: note(stringValue(event.data, "text")) }, null)],
              null,
            );
            break;
          case "codex_proxy.tool_start":
            // Reported as thinking rather than as answer text: a client renders it, and the marker
            // lets the same proxy strip it back out of the replayed history (see notes.js).
            openReasoning();
            sendChunk(
              [
                openAIChatDeltaChoice(
                  {
                    reasoning_content: note(
                      `${stringValue(event.data, "name")}${summarizeArguments(event.data.arguments)}`,
                    ),
                  },
                  null,
                ),
              ],
              null,
            );
            break;
          case "response.output_text.annotation.added": {
            const annotation = event.data.annotation;
            if (annotation != null) {
              sendChunk(
                [openAIChatDeltaChoice({ annotations: [chatAnnotationFromResponses(annotation)] }, null)],
                null,
              );
            }
            break;
          }
          case "response.output_item.done": {
            const item = event.data.item;
            if (item != null && typeof item === "object" && stringValue(item, "type") === "reasoning") {
              // Hand the provider's own thinking to the client in the shape it replays back.
              let thinking = reasoningTextOf(item);
              const key = reasoningKey(event.data);
              const streamed = streamedReasoning.get(key) ?? unkeyedReasoning;
              // A done item usually repeats text already sent as deltas. Forward only a missing
              // tail, while still supporting providers that send reasoning only in the done item.
              if (streamed !== "" && thinking.startsWith(streamed)) {
                thinking = thinking.slice(streamed.length);
                if (!streamedReasoning.has(key)) unkeyedReasoning = "";
              }
              streamedReasoning.delete(key);
              if (thinking !== "") {
                openReasoning();
                sendChunk([openAIChatDeltaChoice({ reasoning_content: thinking }, null)], null);
              }
              break;
            }
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
    } catch (err) {
      // Same reasoning as the responses path: the client must be told, not left hanging.
      this.log.error("chat stream failed", { error: err.message, status: err.status });
      closeReasoning();
      sendChunk(
        [openAIChatDeltaChoice({ content: `\n\n[codex-proxy] upstream failed mid-stream: ${err.message}\n` }, null)],
        null,
      );
      writeSSEDone(res);
      res.end();
      return;
    } finally {
      stopKeepalive();
    }

    this.log.info("upstream event types", {
      events: [...eventTypes.entries()].map(([type, count]) => `${type}=${count}`).join(" "),
    });

    closeReasoning();
    sendChunk([openAIChatDeltaChoice({}, finishReason)], null);
    if (sendUsage) sendChunk([], chatUsageFromResponsesUsage(usage));
    writeSSEDone(res);
    res.end();
  }
}

// The progress note shows what was asked with which arguments — a bare tool name says nothing about
// what is happening. Kept short, because it lands in the client's thinking panel.
function summarizeArguments(raw) {
  const text = String(raw ?? "").trim();
  if (text === "" || text === "{}") return "";
  try {
    const parsed = JSON.parse(text);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts = Object.entries(parsed).map(([key, value]) => {
        const shown = typeof value === "string" ? value : JSON.stringify(value);
        return `${key}=${shown}`;
      });
      return clip(`(${parts.join(", ")})`);
    }
  } catch {
    // fall through to the raw text
  }
  return clip(`(${text})`);
}

function clip(text, limit = 140) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…)`;
}

// A Responses reasoning item keeps its text either in content[].reasoning_text or in summary[].text.
function reasoningTextOf(item) {
  const parts = Array.isArray(item.content) ? item.content : Array.isArray(item.summary) ? item.summary : [];
  return parts
    .filter((part) => part != null && typeof part === "object" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
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


// The markdown image a plugin writes for the user must be fetchable by the client, so its URL is
// absolute and built from the Host the request arrived on.
function originOf(req) {
  const host = stringValue(req?.headers, "host");
  return host === "" ? "" : `http://${host}`;
}
