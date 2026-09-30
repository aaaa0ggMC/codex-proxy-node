import { attachOnce, userText } from "../../src/sdk.js";

// Compatibility reference contributor. Module activation itself is handled by the core,
// including when this helper plugin is absent or disabled.

const MENTION = /@plugin:([A-Za-z0-9][A-Za-z0-9_.-]*)/g;

// User-facing documentation for the console's plugin page. Plain Markdown; the console renders it
// with the small renderer in src/markdown.js.
const DOCS = [
  "# mentions",
  "",
  "Write `@plugin:docs` to activate the entire docs module for this conversation.",
  "The core enables its tools, instructions and transforms and attaches its module reference.",
  "The console `docs` pages are for people and never reach the model; optional `lore` adds model-facing reference text.",
  "",
  "- Global disabled state is a default; a user mention overrides it for this conversation.",
  "- `<enable_module>docs</enable_module>` is equivalent to the mention.",
  "- Mentions and explicit enable/disable switches are applied in conversation order; last wins.",
  "- Only user messages activate modules; assistant text never does.",
  "- The module reference is carried in thinking as `<plugin-inject>` and retained by the core.",
  "- Activation does not depend on this compatibility helper plugin being enabled.",
  "- Only loaded modules can be enabled; an unknown name does not create tools.",
].join("\n");

export default {
  name: "mentions",
  namespace: false,
  docs: DOCS,
  instructions:
    "A user mention @plugin:<name> activates the entire loaded plugin for this conversation: its declared tools, instructions, transforms and model-facing reference (instructions and optional lore, never the console docs). The user may also use <enable_module>name</enable_module>; the latest enable/disable operation wins. Module descriptions are not evidence that a file was read. Use only the exact tool names in the current declarations; never invent undeclared tools.",
  contribute({ input, registry, switches = [], disabledPlugins = [] }) {
    const entries = triggered(userText(input), switches).filter((id) => !disabledPlugins.includes(id)).map((id) => ({
      tag: "plugin-inject",
      name: id,
      body: id === "mentions" ? "" : registry.reference(id) ?? "",
    }));
    return attachOnce(input, entries);
  },
};

// Two triggers, both read from every user message: the explicit @plugin marker, and the module
// switch that already exists. "all" is not a plugin name, so it is ignored.
function triggered(text, switches) {
  const ids = [];
  const seen = new Set();
  const add = (name) => {
    const id = String(name ?? "").toLowerCase();
    if (id === "" || id === "all" || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const match of text.matchAll(MENTION)) add(match[1]);
  for (const change of switches) if (change?.verb === "enable") add(change.name);
  return ids;
}
