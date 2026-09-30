import { stringValue } from "../util.js";
import { qualifiedToolName } from "./names.js";

// A tool is the unit everything else is built on: a plugin is just a named bundle of tools plus
// an optional ingest hook, and a document renderer is a tool that happens to return images.
//
// run(args, ctx) may return a string, a content part, or an array of content parts. That return
// value becomes the `function_call_output.output` body verbatim, which is how a tool hands the
// model an image (see chatToolOutput in compat.js).

export class ToolRegistry {
  #tools = new Map();
  #plugins = [];
  #disabled = new Set();

  register(plugin) {
    const name = stringValue(plugin, "name");
    if (name === "") throw new Error("a plugin needs a name");
    if (plugin.context !== undefined && !["auto", "manual"].includes(plugin.context)) throw new Error(`plugin ${name}: context must be auto or manual`);
    for (const tool of plugin.tools ?? []) {
      if (stringValue(tool, "name") === "") throw new Error(`plugin ${name} has a tool without a name`);
      if (typeof tool.run !== "function") throw new Error(`tool ${tool.name} has no run()`);
      if (tool.context !== undefined && !["auto", "manual"].includes(tool.context)) throw new Error(`tool ${tool.name}: context must be auto or manual`);
      // Every tool carries its plugin's name by default, so a model can tell who owns what and two
      // plugins cannot collide by accident. A plugin that wants bare names opts out explicitly.
      const qualified = qualifiedToolName(plugin, tool.name);
      if (this.#tools.has(qualified)) {
        throw new Error(`duplicate tool ${JSON.stringify(qualified)}; opt a plugin out with namespace: false, or rename the tool`);
      }
      this.#tools.set(qualified, { ...tool, name: qualified, plugin: name, context: tool.context ?? plugin.context ?? "auto" });
    }
    // Kept whole, so a plugin with no tools (a pure transform) still has a name to toggle and a
    // place to hang instructions, fences and restoreText off.
    this.#plugins.push(plugin);
    this.ingestors.push(plugin);
    return this;
  }

  ingestors = [];

  // Attachments are handed to whichever plugin knows how to turn them into something the model can
  // read. The first plugin that recognises the file wins.
  async ingest(file) {
    for (const plugin of this.ingestors) {
      if (typeof plugin.ingestFile !== "function") continue;
      const descriptor = await plugin.ingestFile(file);
      if (descriptor != null) return descriptor;
    }
    return null;
  }

  names() {
    return new Set(this.#tools.keys());
  }

  // Toggling takes effect on the next request, because definitions() is read at the start of every
  // agent run. Nothing is re-imported, so a running conversation is unaffected.
  pluginNames() {
    return [...new Set(this.#plugins.map((plugin) => stringValue(plugin, "name")))].sort();
  }

  // instructions collects the prompt fragments of every enabled plugin. They are stable for as
  // long as the plugin set is, so they belong in `instructions` (the cached prefix) and not in the
  // per-request tail.
  instructions(options = {}) {
    const { skip, force } = gates(options);
    const parts = [];
    for (const plugin of this.#plugins) {
      const name = stringValue(plugin, "name");
      if (!this.active(name, skip, force)) continue;
      const text = stringValue(plugin, "instructions");
      if (text !== "") parts.push(text);
    }
    return parts;
  }

  // fenceLanguages is the set of fenced code languages some enabled plugin wants to render. The
  // rewriter uses it to decide which fences to buffer instead of streaming straight through.
  fenceLanguages(options = {}) {
    const { skip, force } = gates(options);
    const languages = new Set();
    for (const plugin of this.#plugins) {
      const name = stringValue(plugin, "name");
      if (!this.active(name, skip, force)) continue;
      const fences = plugin.fences;
      if (fences == null || typeof fences !== "object") continue;
      for (const language of Object.keys(fences)) languages.add(language.toLowerCase());
    }
    return languages;
  }

  // renderFence asks the first enabled plugin that claims the language to replace the fence. A
  // renderer that throws is treated as declining, so one bad diagram cannot break a whole answer.
  renderFence(language, source, options = {}) {
    const key = String(language).toLowerCase();
    const { skip, force } = gates(options);
    for (const plugin of this.#plugins) {
      const name = stringValue(plugin, "name");
      if (!this.active(name, skip, force)) continue;
      const render = plugin.fences?.[key];
      if (typeof render !== "function") continue;
      try {
        const out = render(source, { plugin: name, language: key });
        if (typeof out === "string" && out !== "") return out;
      } catch {
        // leave the fence untouched
      }
    }
    return null;
  }

  // restore turns a rendered answer back into the compact source, applied in plugin order so two
  // plugins can chain without either one having to know the other exists.
  restore(text, options = {}) {
    if (typeof text !== "string" || text === "") return text;
    const { skip, force } = gates(options);
    let out = text;
    for (const plugin of this.#plugins) {
      const name = stringValue(plugin, "name");
      if (!this.active(name, skip, force)) continue;
      if (typeof plugin.restoreText !== "function") continue;
      try {
        const next = plugin.restoreText(out, { plugin: name, fences: options.fences });
        if (typeof next === "string") out = next;
      } catch {
        // keep the previous text
      }
    }
    return out;
  }

  // An answer-image resolver is a plugin hook, not a tool: the model writes a markdown image and the
  // first enabled plugin that understands the source rewrites it for the client. The plugin owns the
  // policy (what a source resolves to, what `visible` means); the core only finds the spans.
  hasImageResolver(options = {}) {
    const { skip, force } = gates(options);
    return this.#plugins.some(
      (plugin) => this.active(stringValue(plugin, "name"), skip, force) && typeof plugin.images?.resolve === "function",
    );
  }

  resolveImage(reference, context = {}) {
    const { skip, force } = gates(context);
    for (const plugin of this.#plugins) {
      const name = stringValue(plugin, "name");
      if (!this.active(name, skip, force)) continue;
      const resolve = plugin.images?.resolve;
      if (typeof resolve !== "function") continue;
      try {
        const out = resolve(reference, context);
        if (typeof out === "string") return out;
      } catch {
        // a plugin that throws does not claim the reference
      }
    }
    return null;
  }

  // Legacy access to optional supplementary text. Whole-module activation uses reference() and
  // the normal per-conversation gates; it does not depend on this field.
  lore(name) {
    for (const plugin of this.#plugins) {
      if (stringValue(plugin, "name") !== name) continue;
      return typeof plugin.lore === "string" && plugin.lore !== "" ? plugin.lore : null;
    }
    return null;
  }

  // The reference a mention activates is only the model-facing part of the module: its
  // instructions, optional lore, and the tool declarations it owns. The `docs` fields are written
  // for the person using the console (see catalog()/admin) and must never reach the prompt — the
  // model's view of a tool is its declaration, and of a module its instructions.
  reference(name) {
    const plugin = this.#plugins.find((entry) => stringValue(entry, "name") === name);
    if (plugin == null) return null;
    const parts = [plugin.instructions, plugin.lore]
      .filter((value) => typeof value === "string" && value !== "");
    for (const tool of this.#tools.values()) {
      if (tool.plugin !== name) continue;
      parts.push([`Tool: ${tool.name}`, tool.description].filter(Boolean).join("\n"));
    }
    return [...new Set(parts)].join("\n\n") || `Plugin ${name} is enabled for this conversation.`;
  }

  // contribute lets a plugin add tail context. It returns:
  //   append   messages to add to the request (the model sees them this turn)
  //   carried  blocks to write into thinking so the client keeps them and replays them
  //   notes    bookkeeping for the client, stripped from the replayed history
  // It is synchronous on purpose: the result becomes part of the upstream prompt, so it has to be a
  // pure function of the request, and same request in must mean same bytes out.
  contribute(request, { exclude = [], include = [], switches = [] } = {}) {
    const skip = new Set(exclude);
    const force = new Set(include);
    const append = [];
    const notes = [];
    const carried = [];
    for (const plugin of this.#plugins) {
      const name = stringValue(plugin, "name");
      if (!this.active(name, skip, force)) continue;
      if (typeof plugin.contribute !== "function") continue;
      let out;
      try {
        out = plugin.contribute({
          request,
          input: Array.isArray(request?.input) ? request.input : [],
          registry: this,
          disabledPlugins: [...skip],
          switches: Array.isArray(switches) ? switches : [],
        });
      } catch {
        continue; // a plugin that throws contributes nothing rather than breaking the request
      }
      if (out == null || typeof out !== "object") continue;
      if (Array.isArray(out.append)) {
        for (const message of out.append) {
          if (message != null && typeof message === "object" && !Array.isArray(message)) append.push(message);
        }
      }
      if (Array.isArray(out.notes)) {
        for (const text of out.notes) if (typeof text === "string" && text !== "") notes.push(text);
      }
      if (Array.isArray(out.carried)) {
        for (const text of out.carried) if (typeof text === "string" && text !== "") carried.push(text);
      }
    }
    return { append, notes, carried };
  }

  // catalog is what the admin console browses: each plugin with its own reference doc, and each
  // tool with the exact declaration the model is given plus the tool's separate user-facing doc.
  catalog() {
    const plugins = new Map();
    for (const plugin of this.#plugins) {
      const name = stringValue(plugin, "name");
      plugins.set(name, { name, enabled: this.isEnabled(name), docs: textOf(plugin.docs), tools: [] });
    }
    for (const tool of this.#tools.values()) {
      const entry = plugins.get(tool.plugin);
      if (entry == null) continue;
      entry.tools.push({
        name: tool.name,
        schema: {
          type: "function",
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.parameters ?? { type: "object", properties: {} },
        },
        docs: textOf(tool.docs),
      });
    }
    return [...plugins.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  hasTransforms() {
    return this.#plugins.some(
      (plugin) => plugin.fences != null || typeof plugin.restoreText === "function",
    );
  }

  toolsOf(pluginName) {
    return [...this.#tools.values()].filter((tool) => tool.plugin === pluginName).map((tool) => tool.name);
  }

  isEnabled(pluginName) {
    return !this.#disabled.has(pluginName);
  }

  // active is the per-request answer: a plugin is on when it is enabled, or when this conversation
  // explicitly switched it back on, and never when the conversation switched it off.
  active(pluginName, skip = new Set(), force = new Set()) {
    return (this.isEnabled(pluginName) || force.has(pluginName)) && !skip.has(pluginName);
  }

  setEnabled(pluginName, enabled) {
    if (!this.pluginNames().includes(pluginName)) throw new Error(`unknown plugin ${JSON.stringify(pluginName)}`);
    if (enabled) this.#disabled.delete(pluginName);
    else this.#disabled.add(pluginName);
    return enabled;
  }

  owns(toolName) {
    return this.#tools.has(toolName);
  }

  contextPolicy(toolName) {
    return this.#tools.get(toolName)?.context ?? "auto";
  }

  // definitions returns the Responses API tool declarations for every registered tool.
  definitions(options = {}) {
    const { skip, force } = gates(options);
    return [...this.#tools.values()]
      .filter((tool) => this.active(tool.plugin, skip, force))
      .map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? { type: "object", properties: {} },
      }));
  }

  async call(toolName, rawArguments, ctx) {
    const tool = this.#tools.get(toolName);
    if (tool == null) throw new Error(`unknown tool ${JSON.stringify(toolName)}`);

    let args = {};
    if (typeof rawArguments === "string" && rawArguments.trim() !== "") {
      try {
        args = JSON.parse(rawArguments);
      } catch {
        throw new Error(`tool ${toolName} received arguments that are not JSON`);
      }
    } else if (rawArguments != null && typeof rawArguments === "object") {
      args = rawArguments;
    }

    const timeoutMs = tool.timeoutMs ?? 60_000;
    const result = await withTimeout(tool.run(args, ctx), timeoutMs, toolName);
    return normalizeToolResult(result);
  }
}

// A plugin gate takes two lists: `exclude` is what a conversation switched off, `include` is what
// it explicitly switched back on. Include exists so a lightweight deployment can ship with a plugin
// off by default and still let a conversation opt in with <enable_module>name</enable_module>.
function gates(options = {}) {
  return { skip: new Set(options.exclude ?? []), force: new Set(options.include ?? []) };
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}

function withTimeout(promise, timeoutMs, toolName) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tool ${toolName} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// normalizeToolResult pins down what a tool may return so the loop never has to guess.
export function normalizeToolResult(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (Array.isArray(result)) {
    for (const part of result) {
      const type = stringValue(part, "type");
      if (type !== "input_text" && type !== "input_image" && type !== "input_audio") {
        throw new Error(`a tool result part must be input_text, input_image or input_audio, got ${JSON.stringify(type)}`);
      }
    }
    return result;
  }
  return JSON.stringify(result);
}
