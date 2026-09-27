import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIVE_HOUR_WINDOW_SECONDS,
  normalizeUsage,
  usageText,
  usageValue,
  usageTTLFromEnv,
} from "../src/usage.js";

const sampleUsagePayload = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 12,
      limit_window_seconds: 18000,
      reset_after_seconds: 17772,
      reset_at: 1789536659,
    },
    secondary_window: {
      used_percent: 94,
      limit_window_seconds: 604800,
      reset_after_seconds: 318791,
      reset_at: 1789837677,
    },
  },
  credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: "0" },
};

function sampleReport() {
  return normalizeUsage(sampleUsagePayload, new Date(1789500000 * 1000));
}

test("normalizeUsage names the two windows", () => {
  const report = sampleReport();

  assert.equal(report.plan_type, "plus");
  assert.equal(report.limit_reached, false);

  const fiveHour = report.windows.five_hour;
  assert.ok(fiveHour, `expected a five_hour entry: ${JSON.stringify(report.windows)}`);
  assert.equal(fiveHour.label, "5h");
  assert.equal(fiveHour.slot, "primary");
  assert.equal(fiveHour.used_percent, 12);
  assert.equal(fiveHour.remaining_percent, 88);
  assert.equal(fiveHour.resets_at, new Date(1789536659 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));

  const weekly = report.windows.weekly;
  assert.ok(weekly);
  assert.equal(weekly.label, "weekly");
  assert.equal(weekly.slot, "secondary");
  assert.equal(weekly.remaining_percent, 6);
  assert.equal(weekly.reset_after_seconds, 318791);
});

test("normalizeUsage falls back to slots and clamps out of range values", () => {
  const report = normalizeUsage(
    {
      plan_type: "free",
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: 140, limit_window_seconds: 3600 },
        secondary_window: { used_percent: -5, limit_window_seconds: 0 },
      },
    },
    new Date(0),
  );

  assert.equal(report.limit_reached, true);
  assert.equal(report.allowed, false);
  assert.equal(report.windows.primary.label, "1h");
  assert.equal(report.windows.primary.used_percent, 100);
  assert.equal(report.windows.primary.remaining_percent, 0);
  assert.equal(report.windows.secondary.remaining_percent, 100);
});

test("normalizeUsage tolerates a missing rate limit", () => {
  const report = normalizeUsage({ plan_type: "plus" }, new Date(0));
  assert.deepEqual(report.windows, {});
  assert.equal(report.limit_reached, false);
});

test("usageText names both windows", () => {
  assert.equal(usageText(sampleReport()), "5h 88% · 7d 6%");
});

test("usageValue picks the tightest window by default", () => {
  const report = sampleReport();
  const cases = [
    ["", 6],
    ["tightest", 6],
    ["five_hour", 88],
    ["5h", 88],
    ["weekly", 6],
    ["7d", 6],
  ];
  for (const [window, want] of cases) {
    assert.equal(usageValue(report, window), want, `usageValue(${window})`);
  }
  assert.equal(usageValue(report, "monthly"), null);
});

test("usageTTLFromEnv reads the override and rejects junk", () => {
  assert.equal(usageTTLFromEnv({}), 15);
  assert.equal(usageTTLFromEnv({ CODEX_PROXY_USAGE_TTL_SECONDS: "60" }), 60);
  assert.equal(usageTTLFromEnv({ CODEX_PROXY_USAGE_TTL_SECONDS: "nope" }), 15);
  assert.equal(usageTTLFromEnv({ CODEX_PROXY_USAGE_TTL_SECONDS: "-3" }), 15);
});

test("windowKey prefers the window length over the slot name", () => {
  const report = normalizeUsage(
    {
      rate_limit: {
        primary_window: { used_percent: 1, limit_window_seconds: FIVE_HOUR_WINDOW_SECONDS },
        secondary_window: { used_percent: 2, limit_window_seconds: 604800 },
      },
    },
    new Date(0),
  );
  assert.deepEqual(Object.keys(report.windows).sort(), ["five_hour", "weekly"]);
});
