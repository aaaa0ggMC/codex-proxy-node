import { upstreamError } from "../errors.js";
import { readStreamEvents } from "../sse.js";
import { stringValue } from "../util.js";

// Some OpenAI-compatible endpoints speak the Responses API directly (no Chat Completions bridge
// needed), so this provider only adds auth headers and normalises the model list.
export class OpenAIResponsesProvider {
  id = "openai-responses";

  constructor({ name, baseURL, apiKey = "", model = "", headers = {}, staticModels = [] }) {
    this.name = name;
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.headers = headers;
    this.staticModels = staticModels;
  }

  #request(path, init, signal) {
    const headers = { ...this.headers, ...(init.headers ?? {}) };
    if (this.apiKey !== "") headers.Authorization = `Bearer ${this.apiKey}`;
    return fetch(`${this.baseURL}${path}`, { ...init, headers, signal });
  }

  async models(signal) {
    if (this.staticModels.length > 0) return this.staticModels;
    const resp = await this.#request("/models", { method: "GET" }, signal);
    if (!resp.ok) throw await upstreamError(resp);
    const payload = await resp.json();
    return (Array.isArray(payload?.data) ? payload.data : [])
      .map((m) => (typeof m === "string" ? m : stringValue(m, "id")))
      .filter(Boolean)
      .map((slug) => ({ slug, supported_in_api: true, visibility: "list" }));
  }

  async *events(request, signal) {
    const body = this.model !== "" ? { ...request, model: this.model } : request;
    const resp = await this.#request(
      "/responses",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      signal,
    );
    if (!resp.ok) throw await upstreamError(resp);
    yield* readStreamEvents(resp.body);
  }

  async usage() {
    return null;
  }
}
