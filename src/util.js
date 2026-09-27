import { randomBytes } from "node:crypto";

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
