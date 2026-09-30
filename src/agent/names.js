// Tool names are part of the wire protocol and of the prompt, so they are assembled in exactly one
// place. The registry names every tool with qualifiedToolName, and a plugin that points at a tool
// in its own prose (an instruction, a hint in a tool result) builds the same string with toolName.
// Renaming the prefix, or a plugin's namespace, is then one edit instead of a search across plugins.

export const TOOL_PREFIX = "proxy";

// The bare tool name a plugin declares, qualified the way it appears on the wire. A plugin opts out
// with namespace: false and its tools keep their bare names.
export function toolName(pluginName, tool, { namespace = true } = {}) {
  return namespace === false ? String(tool) : `${TOOL_PREFIX}_${pluginName}_${tool}`;
}

// The registry resolves a tool through the plugin object it is registering, so the declaration and
// the name cannot disagree about the plugin's name or namespace.
export function qualifiedToolName(plugin, tool) {
  return toolName(String(plugin?.name ?? ""), tool, { namespace: plugin?.namespace !== false });
}
