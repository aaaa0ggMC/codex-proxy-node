import { stringValue } from "./util.js";

// upstreamError turns a non-2xx provider response into an Error that still carries the status, so
// a handler can mirror it instead of flattening everything to 502.
export async function upstreamError(resp) {
  const body = await resp.text();
  let message = body.trim();
  try {
    const payload = JSON.parse(body);
    const detail = stringValue(payload, "detail");
    if (detail !== "") {
      message = detail;
    } else if (payload?.error != null && typeof payload.error === "object") {
      const inner = stringValue(payload.error, "message");
      if (inner !== "") message = inner;
    }
  } catch {
    // Keep the raw body as the message.
  }
  if (message === "") message = `${resp.status} ${resp.statusText}`.trim();
  const error = new Error(`provider returned HTTP ${resp.status}: ${message}`);
  error.status = resp.status;
  return error;
}
