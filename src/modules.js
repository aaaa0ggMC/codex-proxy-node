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
// removed from the text. Every user message is read, so a conversation can switch a module on or
// off partway through; the switches are replayed in order, which makes the result a pure function
// of the history the client sends.
const NAME_ATTR = /\b(?:name|module)\s*=\s*["']?([a-zA-Z0-9_-]+)["']?/i;

// One scan preserves the order of mentions, paired switches and self-closing switches.
const SWITCH = /@plugin:([A-Za-z0-9][A-Za-z0-9_.-]*)|<(disable|enable)_modules?\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\2_modules?\s*>)/gi;

function readName(attributes, inner) {
  const fromAttr = NAME_ATTR.exec(attributes ?? "");
  const fromInner = String(inner ?? "").trim().split(/\s+/)[0] ?? "";
  // A bare name can sit in the tag itself (<disable_module docs />) with no attribute key.
  const bare = String(attributes ?? "").replace(/["'][^"']*["']/g, " ").trim().split(/\s+/)[0] ?? "";
  return (fromAttr?.[1] ?? fromInner).trim() || bare;
}

export function extractModuleSwitches(text) {
  if (typeof text !== "string" || !/@plugin:|<\/?(disable|enable)_modules?\b/i.test(text)) {
    return { switches: [], text };
  }
  const switches = [];
  const collect = (verb, attributes, inner) => {
    const name = readName(attributes, inner);
    if (name !== "") switches.push({ verb: verb.toLowerCase(), name });
    return "";
  };
  const cleaned = text.replace(SWITCH, (match, mention, verb, attributes, inner) => {
    if (mention != null) {
      switches.push({ verb: "enable", name: mention });
      return match;
    }
    return collect(verb, attributes, inner ?? "");
  });
  return { switches, text: cleaned.replace(/[ \t]+\n/g, "\n").trim() };
}

// A switch names a module the way a user typed it, so the name is matched against the loaded
// modules case-insensitively: "@plugin:Docs" and "<enable_module>Docs</enable_module>" reach the
// same plugin as "docs". A name that matches uses the module's own spelling, so the resulting set
// lines up with the registry and with the tools, transforms and instructions it gates.
function moduleName(name, knownModules) {
  const key = String(name ?? "").toLowerCase();
  if (key === "all") return "all";
  for (const module of knownModules) if (String(module).toLowerCase() === key) return module;
  return key;
}

// resolveSwitches replays the switches in order against the modules that exist.
export function resolveSwitches(switches, knownModules = []) {
  const disabled = new Set();
  for (const { verb, name } of switches) {
    const module = moduleName(name, knownModules);
    if (verb === "disable") {
      if (module === "all") for (const known of knownModules) disabled.add(known);
      else disabled.add(module);
    } else if (module === "all") {
      disabled.clear();
    } else {
      disabled.delete(module);
    }
  }
  return disabled;
}

// enabledModules replays only the enable verbs, so a conversation can switch a plugin back on for
// itself — including one that is off by default in the console. A plugin that is off and not named
// here stays off; naming one is the only way back in.
export function enabledModules(switches, knownModules = []) {
  const enabled = new Set();
  for (const { verb, name } of switches) {
    if (verb !== "enable") continue;
    const module = moduleName(name, knownModules);
    if (module === "all") for (const known of knownModules) enabled.add(known);
    else enabled.add(module);
  }
  return enabled;
}

// applyModuleSwitches reads the switches out of the first user message and strips the tags from
// every text part, so the model never sees the control syntax no matter where the client echoed it.
export function applyModuleSwitches(messages, knownModules = []) {
  if (!Array.isArray(messages)) return { disabled: new Set(), switches: [] };
  const switches = [];

  const handle = (target, key, isUser) => {
    const result = extractModuleSwitches(target[key]);
    target[key] = result.text;
    if (isUser) switches.push(...result.switches);
  };

  for (const message of messages) {
    const isUser = message?.role === "user";
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part?.type === "text" && typeof part.text === "string") handle(part, "text", isUser);
      }
    } else if (typeof message?.content === "string") {
      handle(message, "content", isUser);
    }
  }
  return { disabled: resolveSwitches(switches, knownModules), switches };
}

// The Responses input is already normalised into items, and a message's content may be a plain
// string or an array of input_text parts, so both shapes are handled here.
export function applyInputSwitches(input, knownModules = []) {
  if (!Array.isArray(input)) return { disabled: new Set(), switches: [] };
  const switches = [];

  const handle = (holder, key, isUser) => {
    const result = extractModuleSwitches(holder[key]);
    holder[key] = result.text;
    if (isUser) switches.push(...result.switches);
  };

  for (const item of input) {
    if (item == null || typeof item !== "object") continue;
    const isUser = item.role === "user";
    if (typeof item.content === "string") handle(item, "content", isUser);
    else if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "input_text" && typeof part.text === "string") handle(part, "text", isUser);
      }
    }
  }
  return { disabled: resolveSwitches(switches, knownModules), switches };
}
