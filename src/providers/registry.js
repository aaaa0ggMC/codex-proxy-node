import { readFile } from "node:fs/promises";
import { OpenAICompatProvider } from "./openai.js";
import { CodexProvider } from "./codex.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";

// The registry is itself a provider: the server talks to it exactly like it would talk to Codex,
// and it decides which upstream a request belongs to. That is what turns the proxy into a small
// aggregation platform without teaching the server about any of it.

const PROVIDER_TYPES = {
  codex: (name, cfg, ctx) => new CodexProvider({ tokens: ctx.tokens }),
  openai: (name, cfg) =>
    new OpenAICompatProvider({
      baseURL: requireField(name, cfg, "base_url"),
      apiKey: apiKeyOf(cfg),
      model: cfg.model ?? "",
      reasoningEffort: cfg.reasoning_effort ?? "",
      headers: cfg.headers ?? {},
    }),
  "openai-responses": (name, cfg) =>
    new OpenAIResponsesProvider({
      name,
      baseURL: requireField(name, cfg, "base_url"),
      apiKey: apiKeyOf(cfg),
      model: cfg.model ?? "",
      headers: cfg.headers ?? {},
      staticModels: (cfg.models ?? []).map((slug) => ({ slug, supported_in_api: true, visibility: "list" })),
    }),
};

function requireField(name, cfg, field) {
  const value = cfg[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`provider ${JSON.stringify(name)} needs ${JSON.stringify(field)}`);
  }
  return value;
}

// Keys come from an environment variable by preference, so config.json can be committed.
function apiKeyOf(cfg, env = process.env) {
  if (cfg.api_key_env) return env[cfg.api_key_env] ?? "";
  return cfg.api_key ?? "";
}

export async function loadProviderConfig(file, { log, tokens = null } = {}) {
  const raw = JSON.parse(await readFile(file, "utf8"));
  const entries = raw.providers ?? raw;
  const providers = [];
  for (const [name, cfg] of Object.entries(entries)) {
    if (cfg?.enabled === false) continue;
    const build = PROVIDER_TYPES[cfg?.type];
    if (build == null) {
      log?.error("provider skipped: unknown type", { provider: name, type: cfg?.type });
      continue;
    }
    try {
      providers.push([name, build(name, cfg, { tokens })]);
    } catch (err) {
      log?.error("provider skipped", { provider: name, error: err.message });
    }
  }
  return { defaultProvider: raw.default_provider ?? providers[0]?.[0] ?? "", providers };
}

export class ProviderRegistry {
  constructor({ providers, defaultProvider, log = null }) {
    this.providers = new Map(providers);
    this.defaultProvider = defaultProvider;
    this.log = log;
    this.index = new Map();
    this.cachedModels = null;
  }

  names() {
    return [...this.providers.keys()];
  }

  #require(name) {
    const provider = this.providers.get(name);
    if (provider == null) throw new Error(`unknown provider ${JSON.stringify(name)}`);
    return provider;
  }

  // splitModel understands "provider/model" and returns the bare model otherwise.
  splitModel(model) {
    const slash = String(model ?? "").indexOf("/");
    if (slash > 0) {
      const name = model.slice(0, slash);
      if (this.providers.has(name)) return { provider: name, model: model.slice(slash + 1) };
    }
    return { provider: "", model: String(model ?? "") };
  }

  async #refreshIndex(signal, { fresh = false } = {}) {
    if (this.cachedModels != null && !fresh) return this.cachedModels;
    const collected = [];
    const index = new Map();
    for (const [name, provider] of this.providers) {
      try {
        for (const model of await provider.models(signal)) {
          collected.push({ provider: name, model });
          const owners = index.get(model.slug) ?? [];
          owners.push(name);
          index.set(model.slug, owners);
        }
      } catch (err) {
        // One unreachable provider must not blank the whole catalogue.
        this.log?.warn("provider model list failed", { provider: name, error: err.message });
      }
    }
    this.index = index;
    this.cachedModels = collected;
    return collected;
  }

  // route picks the provider for a model id: "provider/model" wins, then a unique bare id, then
  // the default provider. Bare ids are kept working so saved client histories keep resolving.
  async route(model, signal) {
    const split = this.splitModel(model);
    if (split.provider !== "") return split;
    await this.#refreshIndex(signal);
    const owners = this.index.get(stripSearch(split.model)) ?? [];
    if (owners.length === 1) return { provider: owners[0], model: split.model };
    if (owners.length > 1) {
      this.log?.warn("model exists on several providers; using the default", { model, owners });
    }
    return { provider: this.defaultProvider, model: split.model };
  }

  // models aggregates every provider, advertising provider/model ids and, when the bare id is
  // unambiguous, that too.
  async models(signal) {
    const collected = await this.#refreshIndex(signal, { fresh: true });
    const out = [];
    const seen = new Set();
    for (const { provider, model } of collected) {
      for (const id of [`${provider}/${model.slug}`, ...(this.index.get(model.slug)?.length === 1 ? [model.slug] : [])]) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ slug: id, supported_in_api: true, visibility: "list" });
      }
    }
    return out;
  }

  async *events(request, signal) {
    const { provider, model } = await this.route(request.model, signal);
    if (provider === "") throw new Error("no providers are configured");
    yield* this.#require(provider).events({ ...request, model }, signal);
  }

  async usage(signal, name = "") {
    const target = name !== "" ? name : this.defaultProvider;
    if (target === "") return null;
    return this.#require(target).usage(signal);
  }
}

export function stripSearch(model) {
  for (const suffix of ["-search-preview", "-search"]) {
    if (model.toLowerCase().endsWith(suffix)) return model.slice(0, -suffix.length);
  }
  return model;
}
