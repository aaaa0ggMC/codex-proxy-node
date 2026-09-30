import { createHash } from "node:crypto";

// Images the proxy shows the user are stored once and referenced by a small URL, so the model's
// answer never carries base64 and a replayed message stays cheap. In-memory on purpose: a restart
// invalidates the URLs, which is the same lifetime the client's own rendered cache has.
const images = new Map();
const MAX_IMAGES = 64;

export function putImage(base64, mime = "image/png") {
  const bytes = Buffer.from(String(base64 ?? ""), "base64");
  if (bytes.length === 0) return null;
  const id = `img_${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}`;
  if (images.size >= MAX_IMAGES && !images.has(id)) images.delete(images.keys().next().value);
  images.set(id, { bytes, mime: String(mime || "image/png") });
  return id;
}

export function getImage(id) {
  return images.get(String(id ?? "")) ?? null;
}

// parseDataURI splits an inline image into the bytes the store keeps and the type it keeps them as.
export function parseDataURI(src) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(src ?? "").trim());
  return match == null ? null : { mime: match[1].toLowerCase(), base64: match[2] };
}

// mediaUrl is absolute when the request told us its origin, so a markdown client treats it as a
// network image (no data: URI quirks). Falls back to a relative path when the origin is unknown.
export function mediaUrl(origin, id) {
  const base = String(origin ?? "").replace(/\/+$/, "");
  return base === "" ? `/media/${id}` : `${base}/media/${id}`;
}

// A handle is what the model is given to refer back to an image it cannot inline.
export const HANDLE = /^img_[a-f0-9]{6,}$/i;
