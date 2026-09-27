// Progress rides the reasoning channel, which clients render (collapsed) and which is not part of
// the answer. Our bookkeeping is wrapped so the same proxy can strip it back out of the history a
// client replays:
//
//   <th>                        a thinking block, folded away by the client
//     <mth>model reasoning</mth>
//     tool calls and their results
//     <ignore>progress notes</ignore>
//   </th>
//
// Only <ignore> content is bookkeeping, so that is what we both write and remove.
export const IGNORE_OPEN = "<ignore>";
export const IGNORE_CLOSE = "</ignore>";

export function note(text) {
  return `${IGNORE_OPEN}${text}${IGNORE_CLOSE}`;
}

const PAIRED_IGNORE = /<ignore\b[^>]*>[\s\S]*?<\/ignore\s*>/gi;
const UNTERMINATED_IGNORE = /<ignore\b[^>]*>[\s\S]*$/i;
const EMPTY_TH = /<th\b[^>]*>\s*<\/th\s*>/gi;
const ORPHAN_IGNORE = /<\/?ignore\b[^>]*>/gi;

// stripNotes removes bookkeeping and nothing else. It runs until the text stops changing, because
// removing an inner span can expose another one (nested tags), and it also cleans up the residue a
// half-formed or unbalanced block would otherwise leave behind.
export function stripNotes(text) {
  if (typeof text !== "string") return text;
  if (!text.includes("<ignore") && !text.includes("</ignore")) return text;

  let out = text;
  for (let pass = 0; pass < 8; pass++) {
    const before = out;
    out = out.replace(PAIRED_IGNORE, "");
    out = out.replace(UNTERMINATED_IGNORE, "");
    out = out.replace(ORPHAN_IGNORE, "");
    // A thinking block that held nothing but bookkeeping should not survive as an empty shell.
    out = out.replace(EMPTY_TH, "");
    if (out === before) break;
  }

  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The <th>/<mth> wrapper is ours, so it is removed as well when the thinking has to be handed back
// to a provider: the model should see its own reasoning, not the markup we wrapped it in.
export function stripWrapper(text) {
  const withoutNotes = stripNotes(text);
  if (typeof withoutNotes !== "string") return withoutNotes;
  return withoutNotes
    .replace(/<\/?m?th\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
