// Switches written into the first user message of a conversation:
//
//   <disable_module>docs</disable_module>   turn one module off
//   <disable_modules>all</disable_modules>  turn everything off
//   <enable_module name="docs" />           turn one back on
//
// The singular and plural spellings are interchangeable. Switches are applied in the order they
// appear, so "<disable_modules>all</disable_modules><enable_modules>docs</enable_modules>" means
// "everything except docs" — which is the point of supporting both.
//
// They are control information, not something the upstream model should see, so the tags are always
// removed from the text. Only the first user message is read, which keeps the scan to one message
// and makes the choice a property of the conversation rather than of a single turn.
const NAME_ATTR = /\b(?:name|module)\s*=\s*["']?([a-zA-Z0-9_-]+)["']?/i;

const PAIRED = /<(disable|enable)_modules?\b([^>]*)>([\s\S]*?)<\/\1_modules?\s*>/gi;
const SELF_CLOSING = /<(disable|enable)_modules?\b([^>]*?)\/>/gi;

function readName(attributes, inner) {
  const fromAttr = NAME_ATTR.exec(attributes ?? "");
  const fromInner = String(inner ?? "").trim().split(/\s+/)[0] ?? "";
  // A bare name can sit in the tag itself (<disable_module docs />) with no attribute key.
  const bare = String(attributes ?? "").replace(/["'][^"']*["']/g, " ").trim().split(/\s+/)[0] ?? "";
  return (fromAttr?.[1] ?? fromInner).trim() || bare;
}

export function extractModuleSwitches(text) {
  if (typeof text !== "string" || !/<\/?(disable|enable)_modules?\b/i.test(text)) {
    return { switches: [], text };
  }
  const switches = [];
  const collect = (verb, attributes, inner) => {
    const name = readName(attributes, inner);
    if (name !== "") switches.push({ verb: verb.toLowerCase(), name });
    return "";
  };
  // Paired first, then self-closing: one regex doing both is ambiguous about where attributes end.
  const cleaned = text
    .replace(PAIRED, (_m, verb, attributes, inner) => collect(verb, attributes, inner))
    .replace(SELF_CLOSING, (_m, verb, attributes) => collect(verb, attributes, ""));
  return { switches, text: cleaned.replace(/[ \t]+\n/g, "\n").trim() };
}

// resolveSwitches replays the switches in order against the modules that exist.
export function resolveSwitches(switches, knownModules = []) {
  const disabled = new Set();
  for (const { verb, name } of switches) {
    if (verb === "disable") {
      if (name.toLowerCase() === "all") for (const module of knownModules) disabled.add(module);
      else disabled.add(name);
    } else if (name.toLowerCase() === "all") {
      disabled.clear();
    } else {
      disabled.delete(name);
    }
  }
  return disabled;
}

// applyModuleSwitches reads the switches out of the first user message and strips the tags from
// every text part, so the model never sees the control syntax no matter where the client echoed it.
export function applyModuleSwitches(messages, knownModules = []) {
  if (!Array.isArray(messages)) return new Set();
  const switches = [];
  let scanned = false;

  const handle = (target, key, isFirstUser) => {
    const result = extractModuleSwitches(target[key]);
    target[key] = result.text;
    if (isFirstUser) switches.push(...result.switches);
  };

  for (const message of messages) {
    const isFirstUser = !scanned && message?.role === "user";
    if (isFirstUser) scanned = true;
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part?.type === "text" && typeof part.text === "string") handle(part, "text", isFirstUser);
      }
    } else if (typeof message?.content === "string") {
      handle(message, "content", isFirstUser);
    }
  }
  return resolveSwitches(switches, knownModules);
}
