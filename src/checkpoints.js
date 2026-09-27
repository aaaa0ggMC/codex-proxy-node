// A checkpoint is state we want to survive the client compacting its history.
//
// It rides the thinking channel: the client folds it away, stores it, and replays it with the rest
// of the conversation — and the proxy, on the way back in, lifts it out and re-injects it as
// context. That makes the client's own history the storage, so no session id and no server-side
// conversation state is needed.
//
// Deliberately NOT inside <ignore>: notes are bookkeeping and get removed, a checkpoint is content
// that must come back.
export const CHECKPOINT_OPEN = "<checkpoint>";
export const CHECKPOINT_CLOSE = "</checkpoint>";

const PATTERN = /<checkpoint\b[^>]*>([\s\S]*?)<\/checkpoint\s*>/gi;

export function checkpoint(text) {
  return `${CHECKPOINT_OPEN}${String(text).trim()}${CHECKPOINT_CLOSE}`;
}

// extractCheckpoints pulls the blocks out of a replayed message and returns the text without them,
// so a checkpoint is never fed to the provider twice.
export function extractCheckpoints(text) {
  if (typeof text !== "string" || !text.includes(CHECKPOINT_OPEN)) return { cleaned: text, blocks: [] };
  const blocks = [];
  const cleaned = text.replace(PATTERN, (_match, inner) => {
    const value = String(inner).trim();
    if (value !== "") blocks.push(value);
    return "";
  });
  return { cleaned: cleaned.replace(/\n{3,}/g, "\n\n").trim(), blocks };
}

export function hasCheckpoint(text) {
  return typeof text === "string" && text.includes(CHECKPOINT_OPEN);
}
