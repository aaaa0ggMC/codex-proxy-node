import { endpoints } from "./endpoints.js";

// CodexClient talks to the same ChatGPT backend the Codex CLI uses: the model catalogue, the
// streaming Responses endpoint, and the rate limit (usage) endpoint.
export class CodexClient {
  constructor({ tokens }) {
    this.tokens = tokens;
  }

  authHeaders(token) {
    const headers = { Authorization: `Bearer ${token.accessToken}` };
    if (token.accountId !== "") headers["ChatGPT-Account-ID"] = token.accountId;
    return headers;
  }

  async models(signal) {
    const token = await this.tokens.token(signal);
    const resp = await fetch(`${endpoints.codexBaseURL}/models?client_version=1.0.0`, {
      headers: this.authHeaders(token),
      signal,
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Codex models request failed: HTTP ${resp.status}: ${body.trim()}`);
    }
    const payload = await resp.json();
    return payload.models ?? [];
  }

  // streamResponses returns the raw fetch Response; callers own the body and the status check,
  // which keeps the byte-for-byte pass-through of /v1/responses possible.
  async streamResponses(payload, signal) {
    const token = await this.tokens.token(signal);
    return fetch(`${endpoints.codexBaseURL}/responses`, {
      method: "POST",
      headers: {
        ...this.authHeaders(token),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
      signal,
    });
  }
}
