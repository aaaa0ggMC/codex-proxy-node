import { clampPercent, round2, stringValue } from "./util.js";

// The Codex backend exposes the same numbers the CLI shows in /status: a short metering window
// (5 hours on the current plans), a long one (a week) and optional credits. The proxy asks the
// same endpoint the CLI does and normalises it for clients.
export const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
export const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export const usageTTLEnv = "CODEX_PROXY_USAGE_TTL_SECONDS";
export const defaultUsageTTLSeconds = 15;

export function usageTTLFromEnv(env = process.env) {
  const value = env[usageTTLEnv];
  if (value == null || value === "") return defaultUsageTTLSeconds;
  const seconds = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0) return defaultUsageTTLSeconds;
  return seconds;
}

function asNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// NormalizeUsage turns the backend payload into the stable report clients see: the windows are
// keyed by how long they last (five_hour / weekly) so a client does not have to know which slot
// the plan happens to meter.
export function normalizeUsage(raw, now) {
  const report = {
    plan_type: stringValue(raw, "plan_type") || undefined,
    limit_reached: false,
    windows: {},
    credits: raw?.credits ?? undefined,
    fetched_at: new Date(now.getTime()).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };

  const rateLimit = raw?.rate_limit;
  if (rateLimit == null) return report;

  if (rateLimit.allowed != null) report.allowed = rateLimit.allowed;
  report.limit_reached = rateLimit.limit_reached === true;

  const slots = [
    ["primary", rateLimit.primary_window],
    ["secondary", rateLimit.secondary_window],
  ];
  for (const [slot, window] of slots) {
    if (window == null) continue;
    const key = windowKey(slot, window);
    const next = normalizeWindow(slot, window);
    // Two slots can collide on one key if a plan meters something unexpected; the window that
    // is further used is the one worth showing.
    const prev = report.windows[key];
    if (prev != null && !moreUsed(next, prev)) continue;
    report.windows[key] = next;
  }

  attachSummaries(report);
  return report;
}

// attachSummaries fills the flat fields: the tightest window (the number that decides whether
// you can keep working) and the two named windows. The 5 hour / weekly fields are matched by
// window length first and fall back to the plan's primary / secondary slot.
export function attachSummaries(report) {
  const tightest = tightestWindow(report);
  if (tightest != null) {
    report.remaining_percent = round2(remainingOf(tightest));
    report.remaining_label = tightest.short_label;
  }
  for (const window of Object.values(report.windows)) {
    if (window.remaining_percent == null) continue;
    let name = window.short_label;
    if (window.window_seconds === FIVE_HOUR_WINDOW_SECONDS) name = "5h";
    else if (window.window_seconds === WEEKLY_WINDOW_SECONDS) name = "7d";
    const remaining = round2(remainingOf(window));
    if (name === "5h" && report.five_hour_remaining_percent == null) {
      report.five_hour_remaining_percent = remaining;
    }
    if (name === "7d" && report.weekly_remaining_percent == null) {
      report.weekly_remaining_percent = remaining;
    }
  }
  if (report.five_hour_remaining_percent == null) {
    const window = findWindow(report, "primary");
    if (window != null) report.five_hour_remaining_percent = round2(remainingOf(window));
  }
  if (report.weekly_remaining_percent == null) {
    const window = findWindow(report, "secondary");
    if (window != null) report.weekly_remaining_percent = round2(remainingOf(window));
  }
}

export function findWindow(report, slot) {
  for (const window of Object.values(report.windows)) {
    if (window.slot === slot) return window;
  }
  return null;
}

export function tightestWindow(report) {
  const windows = usageWindows(report);
  if (windows.length === 0) return null;
  let tightest = windows[0];
  for (const candidate of windows.slice(1)) {
    if (remainingOf(candidate) < remainingOf(tightest)) tightest = candidate;
  }
  return tightest;
}

function moreUsed(candidate, current) {
  if (candidate.used_percent == null) return false;
  if (current.used_percent == null) return true;
  return candidate.used_percent > current.used_percent;
}

export function windowKey(slot, window) {
  const seconds = asNumber(window?.limit_window_seconds);
  if (seconds === FIVE_HOUR_WINDOW_SECONDS) return "five_hour";
  if (seconds === WEEKLY_WINDOW_SECONDS) return "weekly";
  return slot;
}

export function normalizeWindow(slot, window) {
  const windowSeconds = asNumber(window?.limit_window_seconds);
  const out = {
    label: windowLabel(windowSeconds),
    short_label: shortWindowLabel(windowSeconds),
    slot,
    window_seconds: windowSeconds,
    used_percent: null,
    remaining_percent: null,
    reset_after_seconds: asNumber(window?.reset_after_seconds),
  };
  const usedPercent = asNumber(window?.used_percent);
  if (usedPercent != null) {
    const used = clampPercent(usedPercent);
    out.used_percent = used;
    out.remaining_percent = clampPercent(100 - used);
  }
  const resetAt = asNumber(window?.reset_at);
  if (resetAt != null) {
    out.resets_at_unix = resetAt;
    out.resets_at = new Date(resetAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return out;
}

export function windowLabel(seconds) {
  if (seconds == null) return "";
  if (seconds === FIVE_HOUR_WINDOW_SECONDS) return "5h";
  if (seconds === WEEKLY_WINDOW_SECONDS) return "weekly";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.floor(seconds / 60)}m`;
}

// shortWindowLabel is what fits in a one line display: 5h, 7d, 30m.
export function shortWindowLabel(seconds) {
  if (seconds == null || seconds <= 0) return "quota";
  if (seconds === FIVE_HOUR_WINDOW_SECONDS) return "5h";
  if (seconds === WEEKLY_WINDOW_SECONDS) return "7d";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

// usageWindows returns the report's windows ordered shortest first, which is the order a one
// line display wants: the 5 hour window before the weekly one.
export function usageWindows(report) {
  if (report == null) return [];
  return Object.values(report.windows).sort((a, b) => {
    const left = a.window_seconds;
    const right = b.window_seconds;
    if (left == null) return 1;
    if (right == null) return -1;
    return left - right;
  });
}

// usageText is the one line form: "5h 100% · 7d 6%".
export function usageText(report) {
  const windows = usageWindows(report);
  if (windows.length === 0) return "usage unavailable";
  return windows.map((w) => `${w.short_label} ${Math.round(remainingOf(w))}%`).join(" · ");
}

// usageValue is the single number a plain "remaining" field wants: by default the window that
// is closest to running out, because that is the one that actually gates you.
export function usageValue(report, window = "") {
  if (report == null) return null;
  switch (window) {
    case "":
    case "tightest":
    case "min":
      return report.remaining_percent ?? null;
    case "five_hour":
    case "5h":
    case "primary":
      return report.five_hour_remaining_percent ?? null;
    case "weekly":
    case "7d":
    case "secondary":
      return report.weekly_remaining_percent ?? null;
    default:
      return null;
  }
}

export function remainingOf(window) {
  return window.remaining_percent == null ? 0 : window.remaining_percent;
}

// usageReport returns a cached report when it is still fresh, otherwise it asks the backend.
// It always resolves with { report, error }: when the refresh fails but an older report exists,
// that report comes back marked stale alongside the error, so a dashboard keeps showing the
// last known numbers while the caller can still log why the number is old.
export async function usageReport(server, refresh, signal) {
  return server.withUsageLock(async () => {
    let ttl = server.usageTTL;
    if (ttl == null || ttl < 0) ttl = defaultUsageTTLSeconds;
    if (!refresh && server.usageCache != null && (Date.now() - server.usageCacheAt) / 1000 < ttl) {
      return { report: server.usageCache, error: null };
    }

    try {
      const report = await server.provider.usage(signal);
      if (report == null) {
        throw new Error("the configured provider does not report usage");
      }
      server.usageCache = report;
      server.usageCacheAt = Date.now();
      return { report, error: null };
    } catch (err) {
      if (server.usageCache == null) return { report: null, error: err };
      return { report: { ...server.usageCache, stale: true }, error: err };
    }
  });
}
