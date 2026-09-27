import { CodexClient } from "../codex.js";
import { endpoints } from "../endpoints.js";
import { upstreamError } from "../errors.js";
import { readStreamEvents } from "../sse.js";
import { normalizeUsage } from "../usage.js";
import { truncate } from "../util.js";

// The Codex provider is the native one: the ChatGPT Codex backend already speaks the Responses
// API, so requests and events pass through untouched.
export class CodexProvider {
  id = "codex";

  constructor({ tokens }) {
    this.client = new CodexClient({ tokens });
  }

  async models(signal) {
    return this.client.models(signal);
  }

  async *events(request, signal) {
    const resp = await this.client.streamResponses(request, signal);
    if (!resp.ok) throw await upstreamError(resp);
    yield* readStreamEvents(resp.body);
  }

  async usage(signal) {
    const token = await this.client.tokens.token(signal);
    const resp = await fetch(endpoints.usageURL, {
      headers: { ...this.client.authHeaders(token), Accept: "application/json" },
      signal,
    });
    const body = await resp.text();
    if (!resp.ok) {
      throw new Error(`Codex usage request failed: HTTP ${resp.status}: ${truncate(body, 300)}`);
    }
    return normalizeUsage(JSON.parse(body), new Date());
  }
}
