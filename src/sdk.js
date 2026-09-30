// The plugin SDK.
//
// Every plugin that needs to hand the model something persistent follows one pattern: write a block
// into the thinking channel so the client stores it, and on the next request read it back out of the
// client's own history. Checkpoints and plugin-injected references are the same shape, so the
// parsing, formatting and "do not inject what is already there" rules live here once. A plugin that
// uses this SDK is complete on both rails; the transport needs no per-plugin knowledge.

// A block written into the thinking channel has one of two dispositions when the client replays it:
//
//   ignored  the client stores it and shows it, the proxy strips it — progress and bookkeeping the
//            model never needs to see again
//   carried  the client stores it and the proxy lifts it back out as context — anything the model
//            must keep, a checkpoint or a plugin-injected reference
//
// Both are the same mechanism with a different disposition, which is why they live here together.
export const IGNORED = "ignored";
export const CARRIED = "carried";

// Tags the SDK treats as carried blocks. Adding one here makes it work outbound (emitted, kept by
// the client) and inbound (lifted out of the replayed history) with no other change.
//
// plugin-fence carries the source of an answer fence a plugin rendered (the model's mermaid behind
// a drawn diagram). It is carried, not ignored: the model must keep it to remember what it drew.
export const CARRIED_TAGS = ["checkpoint", "plugin-inject", "plugin-fence"];

const PATTERN = new RegExp(`<(${CARRIED_TAGS.join("|")})\\b([^>]*)>([\\s\\S]*?)<\\/\\1\\s*>`, "gi");
const NAME_ATTR = /\bname\s*=\s*["']?([^"'\s>]+)["']?/i;

// The thinking envelope: a folded reasoning block, and the markers the proxy writes inside it.
export const THINKING_OPEN = "<th><mth>";
export const THINKING_CLOSE = "</mth></th>";

// ignored is the bookkeeping disposition: shown once, stripped on replay.
export function ignored(body) {
  return `<ignore>${String(body ?? "")}</ignore>`;
}

// write is the unified entry point; a caller that knows only the disposition does not have to know
// which tag it implies.
export function write(disposition, { tag = "", name = "", body = "" } = {}) {
  return disposition === IGNORED ? ignored(body) : carriedBlock(tag, { name, body });
}

// carriedBlock is the wire form: one self-describing block a client can store and replay verbatim.
export function carriedBlock(tag, { name = "", body = "" } = {}) {
  const attribute = String(name ?? "") === "" ? "" : ` name="${String(name).replace(/["<>]/g, "")}"`;
  return `<${tag}${attribute}>\n${String(body ?? "")}\n</${tag}>`;
}

// parseCarried lifts every carried block out of a piece of text and returns the rest, so the same
// content is never fed to the provider twice.
export function parseCarried(text) {
  if (typeof text !== "string" || !text.includes("<")) return { cleaned: text, blocks: [] };
  const blocks = [];
  const cleaned = text.replace(PATTERN, (_match, tag, attributes, body) => {
    const value = String(body ?? "").trim();
    if (value !== "") blocks.push({ tag: String(tag).toLowerCase(), name: NAME_ATTR.exec(attributes ?? "")?.[1] ?? "", body: value });
    return "";
  });
  if (blocks.length === 0) return { cleaned: text, blocks: [] };
  return { cleaned: normalize(cleaned), blocks };
}

const PAIRED_IGNORE = /<ignore\b[^>]*>([\s\S]*?)<\/ignore\s*>/gi;
const UNTERMINATED_IGNORE = /<ignore\b[^>]*>([\s\S]*)$/i;
const ORPHAN_IGNORE = /<\/?ignore\b[^>]*>/gi;
const EMPTY_TH = /<th\b[^>]*>\s*<\/th\s*>/gi;
const WRAPPER = /<\/?m?th\b[^>]*>/gi;

// read is the one parser for everything the proxy writes into thinking. It returns the text with all
// of it removed, plus what it found on each rail — so no caller has to know the tags, and the
// "already carried" check and the "never fed twice" rule use the same scan.
export function read(text, { carried: takeCarried = true, ignored: takeIgnored = true } = {}) {
  if (typeof text !== "string" || !text.includes("<")) return { text, carried: [], ignored: [] };

  const parsed = takeCarried ? parseCarried(text) : { cleaned: text, blocks: [] };
  const carried = parsed.blocks;
  let out = parsed.cleaned;
  if (!takeIgnored) return { text: out, carried, ignored: [] };
  const ignoredBlocks = [];
  for (let pass = 0; pass < 8; pass++) {
    const before = out;
    out = out.replace(PAIRED_IGNORE, (_match, inner) => {
      ignoredBlocks.push(String(inner));
      return "";
    });
    out = out.replace(UNTERMINATED_IGNORE, (_match, inner) => {
      ignoredBlocks.push(String(inner));
      return "";
    });
    out = out.replace(ORPHAN_IGNORE, "");
    // A thinking block that held nothing but bookkeeping should not survive as an empty shell.
    out = out.replace(EMPTY_TH, "");
    if (out === before) break;
  }
  return { text: out, carried, ignored: ignoredBlocks };
}

// unwrap removes the folded <th>/<mth> envelope the chat transport adds around reasoning.
export function unwrap(text) {
  return typeof text === "string" ? text.replace(WRAPPER, "") : text;
}

// normalize collapses the whitespace a removed block leaves behind.
export function normalize(text) {
  return typeof text !== "string" ? text : text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function hasCarried(text, { tag = "", name = "" } = {}) {
  return parseCarried(text).blocks.some(
    (block) => (tag === "" || block.tag === tag) && (name === "" || block.name === name),
  );
}

// liftCarried is the inbound counterpart of the writer helpers: it removes every proxy-written block
// from a replayed message and returns the blocks WITH their tags, so a caller can tell state it must
// re-inject (a checkpoint, a plugin reference) apart from a rendered answer it must restore (a fence).
export function liftCarried(text) {
  if (typeof text !== "string" || !text.includes("<")) return { cleaned: text, blocks: [] };
  const { text: cleaned, carried } = read(text, { ignored: false });
  if (carried.length === 0) return { cleaned: text, blocks: [] };
  return { cleaned, blocks: carried };
}

// fenceSources groups lifted <plugin-fence> blocks by the language they render. A renderer's
// restoreText uses it to recover its source from the client's own history, so a diagram drawn before
// a proxy restart still comes back as the model's own text rather than as generated markup.
export function fenceSources(blocks = []) {
  const map = new Map();
  for (const block of blocks) {
    if (block?.tag !== "plugin-fence") continue;
    const list = map.get(block.name) ?? [];
    list.push(block.body);
    map.set(block.name, list);
  }
  return map;
}

// attachOnce is the whole pattern in one call, and the reason a transform plugin stays small: given
// what the client already holds and the content a trigger asked for, it returns the messages to add
// to this request (`append`) and the blocks to write into thinking (`carried`). Content the client
// already carries is skipped, so a trigger that stays in the history does not re-attach anything.
export function attachOnce(input, entries) {
  const known = contextText(input);
  const append = [];
  const carried = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const body = String(entry?.body ?? "");
    if (body === "" || known.includes(body)) continue;
    const block = carriedBlock(entry.tag, { name: entry.name, body });
    append.push({ role: "developer", content: block });
    carried.push(block);
  }
  return append.length > 0 ? { append, carried } : null;
}

// Everything the model is about to be given, and everything the client replayed, so a presence
// check finds content no matter which rail it arrived on.
export function contextText(input) {
  const parts = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (item == null || typeof item !== "object") continue;
    collect(item.content, parts);
    collect(item.output, parts);
  }
  return parts.join("\n");
}

// Only what the user wrote: an assistant echoing a marker must not re-arm a trigger, and content the
// model invented is not a request the user made.
export function userText(input) {
  const parts = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (item == null || typeof item !== "object" || item.role !== "user") continue;
    collect(item.content, parts);
  }
  return parts.join("\n");
}

function collect(content, parts) {
  if (typeof content === "string") {
    parts.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part != null && typeof part === "object" && typeof part.text === "string") parts.push(part.text);
  }
}

// Tool naming for plugins. A plugin declares bare tool names; when it needs to point at a tool in
// its own prose it builds the wire name here rather than pasting a literal, so the prefix lives in
// one place (see src/agent/names.js).
export { TOOL_PREFIX, toolName } from "./agent/names.js";
