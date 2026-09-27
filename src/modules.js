// A switch written into the first user message of a conversation:
//
//   <disable_module>docs</disable_module>
//   <disable_module name="docs" />
//   <disable_module docs />
//
// It is control information, not something the upstream model should ever see, so the tag is always
// removed from the text. Only the first user message is read, which keeps the scan cheap and makes
// the switch a property of the conversation rather than of a single turn.
const PAIRED = /<disable_module\b([^>]*)>([\s\S]*?)<\/disable_module\s*>/gi;
const SELF_CLOSING = /<disable_module\b([^>]*?)\/>/gi;
const NAME_ATTR = /\b(?:name|module)\s*=\s*["']?([a-zA-Z0-9_-]+)["']?/i;

export function extractModuleSwitches(text) {
  if (typeof text !== "string" || !text.includes("<disable_module")) {
    return { modules: [], text };
  }
  const modules = [];
  const collect = (attributes, inner) => {
    const fromAttr = NAME_ATTR.exec(attributes ?? "");
    const fromInner = String(inner ?? "").trim().split(/\s+/)[0] ?? "";
    // A bare name can sit in the tag itself (<disable_module docs />) with no attribute key.
    const bare = String(attributes ?? "").replace(/["'][^"']*["']/g, " ").trim().split(/\s+/)[0] ?? "";
    const name = (fromAttr?.[1] ?? fromInner).trim() || bare;
    if (name !== "") modules.push(name);
    return "";
  };
  // Paired first, then self-closing: one regex trying to do both is ambiguous about where the
  // attributes end.
  const cleaned = text
    .replace(PAIRED, (_m, attributes, inner) => collect(attributes, inner))
    .replace(SELF_CLOSING, (_m, attributes) => collect(attributes, ""));
  return { modules: [...new Set(modules)], text: cleaned.replace(/[ \t]+\n/g, "\n").trim() };
}

// applyModuleSwitches reads the switch out of the first user message and strips the tag from every
// text part, so the model never sees the control syntax no matter where the client echoed it.
export function applyModuleSwitches(messages) {
  const disabled = new Set();
  if (!Array.isArray(messages)) return disabled;
  let scanned = false;

  for (const message of messages) {
    const isFirstUser = !scanned && message?.role === "user";
    if (isFirstUser) scanned = true;
    const parts = Array.isArray(message?.content) ? message.content : null;
    if (parts == null) {
      if (typeof message?.content !== "string" || !message.content.includes("<disable_module")) continue;
      const result = extractModuleSwitches(message.content);
      message.content = result.text;
      if (isFirstUser) for (const name of result.modules) disabled.add(name);
      continue;
    }
    for (const part of parts) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      const result = extractModuleSwitches(part.text);
      part.text = result.text;
      if (isFirstUser) for (const name of result.modules) disabled.add(name);
    }
  }
  return disabled;
}
