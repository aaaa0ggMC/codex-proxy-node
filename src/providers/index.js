import { CodexProvider } from "./codex.js";
import { OpenAICompatProvider } from "./openai.js";

export function createProvider(cfg, { tokens }) {
  switch (cfg.provider) {
    case "codex":
      return new CodexProvider({ tokens });
    case "openai":
      return new OpenAICompatProvider({
        baseURL: cfg.upstream,
        apiKey: cfg.upstreamKey,
        model: cfg.upstreamModel,
        reasoningEffort: cfg.reasoningEffort,
      });
    default:
      throw new Error(`unknown provider ${JSON.stringify(cfg.provider)}; use codex or openai`);
  }
}
