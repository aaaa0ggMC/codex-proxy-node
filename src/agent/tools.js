import { stringValue } from "../util.js";

// A tool is the unit everything else is built on: a plugin is just a named bundle of tools plus
// an optional ingest hook, and a document renderer is a tool that happens to return images.
//
// run(args, ctx) may return a string, a content part, or an array of content parts. That return
// value becomes the `function_call_output.output` body verbatim, which is how a tool hands the
// model an image (see chatToolOutput in compat.js).

export class ToolRegistry {
  #tools = new Map();
  #disabled = new Set();

  register(plugin) {
    const name = stringValue(plugin, "name");
    if (name === "") throw new Error("a plugin needs a name");
    for (const tool of plugin.tools ?? []) {
      if (stringValue(tool, "name") === "") throw new Error(`plugin ${name} has a tool without a name`);
      if (typeof tool.run !== "function") throw new Error(`tool ${tool.name} has no run()`);
      // Namespacing is opt-in because a plugin's tool names are part of the prompt, and only the
      // plugin author knows whether it wants to own a short, model-friendly name.
      const toolName = plugin.namespace === true ? `${name}__${tool.name}` : tool.name;
      if (this.#tools.has(toolName)) {
        throw new Error(`duplicate tool ${JSON.stringify(toolName)}; set namespace: true on the plugin`);
      }
      this.#tools.set(toolName, { ...tool, name: toolName, plugin: name });
    }
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
    return [...new Set([...this.#tools.values()].map((tool) => tool.plugin))].sort();
  }

  toolsOf(pluginName) {
    return [...this.#tools.values()].filter((tool) => tool.plugin === pluginName).map((tool) => tool.name);
  }

  isEnabled(pluginName) {
    return !this.#disabled.has(pluginName);
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

  // definitions returns the Responses API tool declarations for every registered tool.
  definitions() {
    return [...this.#tools.values()]
      .filter((tool) => this.isEnabled(tool.plugin))
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
