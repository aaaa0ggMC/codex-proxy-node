import { upstreamError } from "../errors.js";
import { readStreamEvents } from "../sse.js";
import { randomHex } from "../util.js";
import {
  chatModelsToCodexModels,
  chatStreamToResponses,
  toChatRequest,
} from "./chat-bridge.js";

// Any OpenAI-compatible endpoint (DeepSeek, StepFun, a local llama.cpp, ...) becomes a provider by
// translating the canonical Responses request down to Chat Completions and the stream back up.
export class OpenAICompatProvider {
  id = "openai";

  constructor({ baseURL, apiKey = "", model = "", reasoningEffort = "", headers = {} }) {
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.headers = headers;
  }

  #request(path, init, signal) {
    const headers = { ...this.headers, ...(init.headers ?? {}) };
    if (this.apiKey !== "") headers.Authorization = `Bearer ${this.apiKey}`;
    return fetch(`${this.baseURL}${path}`, { ...init, headers, signal });
  }

  async models(signal) {
    const resp = await this.#request("/models", { method: "GET" }, signal);
    if (!resp.ok) throw await upstreamError(resp);
    return chatModelsToCodexModels(await resp.json());
  }

  async *events(request, signal) {
    const model = this.model !== "" ? this.model : request.model;
    const body = toChatRequest(request, { model, reasoningEffort: this.reasoningEffort });
    const resp = await this.#request(
      "/chat/completions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      signal,
    );
    if (!resp.ok) throw await upstreamError(resp);
    yield* chatStreamToResponses(readStreamEvents(resp.body), { id: "resp_" + randomHex(16), model });
  }

  // Chat Completions has no standard quota endpoint, so there is nothing to report.
  async usage() {
    return null;
  }
}
