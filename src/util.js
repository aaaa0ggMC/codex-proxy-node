import { createHash, randomBytes } from "node:crypto";

// Mirrors the Go helper of the same name: a missing value is "", and non-string scalars are
// stringified so callers never have to care which JSON shape the client sent.
export function stringValue(m, key) {
  if (m == null) return "";
  const v = m[key];
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

export function defaultedString(m, key, fallback) {
  const value = stringValue(m, key).trim();
  return value === "" ? fallback : value;
}

// Go's boolValue only accepts a real bool; a missing key is false, not "truthy".
export function boolValue(m, key) {
  return m?.[key] === true;
}

export function numberOrZero(v) {
  return v == null ? 0 : v;
}

export function randomHex(bytesLen) {
  return randomBytes(bytesLen).toString("hex");
}

// stableId derives an id from content instead of randomness. Anything the proxy puts into a
// request that a client will send again must be reproducible: a random id here would change the
// prompt prefix on every retry and stop the provider's prefix cache from ever hitting.
export function stableId(prefix, ...parts) {
  const hash = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
  return `${prefix}_${hash}`;
}

// Rounds to two decimals, the same precision the Go report uses.
export function round2(value) {
  return Math.round(value * 100) / 100;
}

export function clampPercent(value) {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

export function truncate(value, limit) {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + "...";
}
