// Progress notes ride the reasoning channel: clients render it, and it is not part of the answer.
// Every note is prefixed with a marker so the same proxy can strip it back out when the client
// replays the conversation, which keeps our bookkeeping from ever reaching the model.
export const NOTE_PREFIX = "[codex-proxy-ignore]";

export function note(text) {
  return `${NOTE_PREFIX} ${text}`;
}

// stripNotes drops whole tagged lines and leaves everything else alone, so a client that merged a
// note into a paragraph still gets the surrounding text through.
export function stripNotes(text) {
  if (typeof text !== "string" || !text.includes(NOTE_PREFIX)) return text;
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(NOTE_PREFIX))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
