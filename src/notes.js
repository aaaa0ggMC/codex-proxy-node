import { ignored, normalize, read, unwrap } from "./sdk.js";

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
// Only <ignore> content is bookkeeping, so that is what we both write and remove. The wrapping and
// parsing itself lives in src/sdk.js, next to the carried blocks that share the same channel.
export const IGNORE_OPEN = "<ignore>";
export const IGNORE_CLOSE = "</ignore>";

// A note shares the thinking channel with the model reasoning. Frame it with newlines so it
// starts on its own line instead of running into the surrounding text; the replay parser ignores
// the extra whitespace.
export function note(text) {
  return `\n${ignored(text)}\n`;
}

// stripNotes removes bookkeeping and nothing else. Carried blocks (a checkpoint, an injected
// reference) are not bookkeeping, so they are left for their own rail to lift.
export function stripNotes(text) {
  if (typeof text !== "string") return text;
  if (!text.includes("<ignore") && !text.includes("</ignore")) return text;
  return normalize(read(text, { carried: false }).text);
}

// The <th>/<mth> wrapper is ours, so it is removed as well when the thinking has to be handed back
// to a provider: the model should see its own reasoning, not the markup we wrapped it in.
export function stripWrapper(text) {
  const withoutNotes = stripNotes(text);
  if (typeof withoutNotes !== "string") return withoutNotes;
  return normalize(unwrap(withoutNotes));
}
