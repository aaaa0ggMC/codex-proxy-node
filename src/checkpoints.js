import { carriedBlock, normalize, parseCarried, read } from "./sdk.js";

// A checkpoint is state we want to survive the client compacting its history.
//
// It rides the thinking channel: the client folds it away, stores it, and replays it with the rest
// of the conversation — and the proxy, on the way back in, lifts it out and re-injects it as
// context. That makes the client's own history the storage, so no session id and no server-side
// conversation state is needed.
//
// This is the carried disposition of the thinking channel; the parser and the wire form live in
// src/sdk.js, next to the ignored disposition that bookkeeping uses.
export const CHECKPOINT_OPEN = "<checkpoint>";
export const CHECKPOINT_CLOSE = "</checkpoint>";

export function checkpoint(text) {
  return carriedBlock("checkpoint", { body: String(text).trim() });
}

// extractCheckpoints pulls every carried block out of a replayed message and returns the text
// without them, so the same content is never fed to the provider twice.
export function extractCheckpoints(text) {
  if (typeof text !== "string" || !text.includes("<")) return { cleaned: text, blocks: [] };
  const { carried } = read(text, { ignored: false });
  if (carried.length === 0) return { cleaned: text, blocks: [] };
  const { cleaned } = parseCarried(text);
  return { cleaned: normalize(cleaned), blocks: carried.map((block) => block.body) };
}

export function hasCheckpoint(text) {
  return typeof text === "string" && parseCarried(text).blocks.length > 0;
}
