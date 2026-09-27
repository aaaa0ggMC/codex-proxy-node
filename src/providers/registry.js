import { readFile } from "node:fs/promises";
import { TokenSource } from "../auth.js";
import { OpenAICompatProvider } from "./openai.js";
import { CodexProvider } from "./codex.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";

// The registry is itself a provider: the server talks to it exactly like it would talk to Codex,
// and it decides which upstream a request belongs to. That is what turns the proxy into a small
// aggregation platform without teaching the server about any of it.

const PROVIDER_TYPES = {
  // Codex takes no key: it uses the ChatGPT login in auth.json. A config entry may still point at
  // a different login directory, which is how you run two accounts side by side.
  codex: (name, cfg, ctx) =>
    new CodexProvider({
      tokens: cfg.codex_home ? new TokenSource({ codexHome: cfg.codex_home }) : ctx.tokens,
    }),
  openai: (name, cfg, ctx) =>
    new OpenAICompatProvider({
      baseURL: requireField(name, cfg, "base_url"),
      apiKey: apiKeyOf(cfg, ctx.env),
      model: cfg.model ?? "",
      reasoningEffort: cfg.reasoning_effort ?? "",
      headers: cfg.headers ?? {},
    }),
  "openai-responses": (name, cfg, ctx) =>
    new OpenAIResponsesProvider({
      name,
      baseURL: requireField(name, cfg, "base_url"),
      apiKey: apiKeyOf(cfg, ctx.env),
      model: cfg.model ?? "",
      reasoningEffort: cfg.reasoning_effort ?? "",
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

// A provider may name an environment variable, write the key inline, or both. Environment wins
// when it actually has a value (so a deployment can override without editing the file), and the
// inline key is the fallback rather than being silently ignored.
function apiKeyOf(cfg, env = process.env) {
  if (cfg.api_key_env) {
    const value = env[cfg.api_key_env];
    if (value) return value;
  }
  return cfg.api_key ?? "";
}

// Providers may be written as an object keyed by name, or as an array where each entry carries
// its own name. Several entries may share a name: they form one namespace, and requests to it try
// them in order, which is how you fail over between two keys for the same service.
export function normalizeEntries(raw) {
  const source = raw?.providers ?? raw ?? {};
  if (Array.isArray(source)) return source;
  return Object.entries(source).map(([name, cfg]) => ({ ...cfg, name: cfg?.name ?? name }));
}

export async function loadProviderConfig(file, { log, tokens = null, env = process.env } = {}) {
  const raw = JSON.parse(await readFile(file, "utf8"));
  const entries = normalizeEntries(raw);
  const providers = [];
  for (const cfg of entries) {
    if (cfg?.enabled === false) continue;
    // `name` is the namespace. An empty name means no namespace at all: that provider's models are
    // exposed under their bare ids, so a client asks for `gpt-5.5`, not `codex/gpt-5.5`.
    const name = typeof cfg?.name === "string" ? cfg.name.trim() : "";
    const build = PROVIDER_TYPES[cfg?.type];
    if (build == null) {
      log?.error("provider skipped: unknown type", { provider: name, type: cfg?.type });
      continue;
    }
    try {
      providers.push([name, build(name, cfg, { tokens, env })]);
    } catch (err) {
      log?.error("provider skipped", { provider: name, error: err.message });
    }
  }
  return { defaultProvider: raw.default_provider ?? providers[0]?.[0] ?? "", providers };
}

export class ProviderRegistry {
  constructor({ providers, defaultProvider, log = null }) {
    // namespace -> [provider, ...]; more than one entry means the namespace fails over.
    this.providers = new Map();
    for (const [name, provider] of providers) {
      const list = this.providers.get(name) ?? [];
      list.push(provider);
      this.providers.set(name, list);
    }
    this.defaultProvider = defaultProvider;
    this.log = log;
    this.index = new Map();
    this.cachedModels = null;
  }

  names() {
    return [...this.providers.keys()];
  }

  #require(name) {
    const list = this.providers.get(name);
    if (list == null || list.length === 0) throw new Error(`unknown provider ${JSON.stringify(name)}`);
    return list;
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
    for (const [name, list] of this.providers) {
      const seen = new Set();
      for (const provider of list) {
        try {
          for (const model of await provider.models(signal)) {
            if (seen.has(model.slug)) continue;
            seen.add(model.slug);
            collected.push({ provider: name, model });
            const owners = index.get(model.slug) ?? [];
            if (!owners.includes(name)) owners.push(name);
            index.set(model.slug, owners);
          }
        } catch (err) {
          // One unreachable provider must not blank the whole catalogue.
          this.log?.warn("provider model list failed", { provider: name, error: err.message });
        }
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
    // A provider that opted out of a namespace owns its bare ids outright.
    if (owners.includes("")) return { provider: "", model: split.model };
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
      const ids =
        provider === ""
          ? [model.slug]
          : [`${provider}/${model.slug}`, ...(this.index.get(model.slug)?.length === 1 ? [model.slug] : [])];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          slug: id,
          supported_in_api: true,
          visibility: "list",
          owned_by: provider,
          search_aliases: model.search_aliases === true,
        });
      }
    }
    return out;
  }

  async *events(request, signal) {
    const { provider, model } = await this.route(request.model, signal);
    const candidates = this.#require(provider);
    if (candidates.length === 0) throw new Error("no providers are configured");

    let lastError = null;
    for (const candidate of candidates) {
      let yielded = false;
      try {
        for await (const event of candidate.events({ ...request, model }, signal)) {
          yielded = true;
          yield event;
        }
        return;
      } catch (err) {
        // Fail over only before anything has been streamed: once a client has seen part of an
        // answer, silently continuing from a second upstream would duplicate it.
        if (yielded) throw err;
        lastError = err;
        this.log?.warn("provider failed, trying the next in the namespace", { provider, error: err.message });
      }
    }
    throw lastError ?? new Error(`provider ${JSON.stringify(provider)} produced no events`);
  }

  async usage(signal, name = "") {
    const target = name !== "" ? name : this.defaultProvider;
    if (target === "") return null;
    return this.#require(target)[0].usage(signal);
  }
}

export function stripSearch(model) {
  for (const suffix of ["-search-preview", "-search"]) {
    if (model.toLowerCase().endsWith(suffix)) return model.slice(0, -suffix.length);
  }
  return model;
}
