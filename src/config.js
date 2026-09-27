import net from "node:net";

export const defaultHost = "127.0.0.1";
export const defaultPort = 6769;
export const apiKeyEnv = "CODEX_PROXY_API_KEY";
export const webSearchEnv = "CODEX_PROXY_WEB_SEARCH";

const providerEnvs = {
  provider: "CODEX_PROXY_PROVIDER",
  config: "CODEX_PROXY_CONFIG",
  upstream: "CODEX_PROXY_UPSTREAM",
  "upstream-key": "CODEX_PROXY_UPSTREAM_KEY",
  "upstream-model": "CODEX_PROXY_UPSTREAM_MODEL",
  "reasoning-effort": "CODEX_PROXY_REASONING_EFFORT",
};

const flagSpec = {
  host: { type: "string", fallback: defaultHost, help: "host/interface to listen on" },
  port: { type: "int", fallback: defaultPort, help: "port to listen on" },
  "codex-home": { type: "string", fallback: "", help: "Codex home directory; defaults to CODEX_HOME or ~/.codex" },
  "api-key": { type: "string", fallback: "", help: "API key required as Authorization bearer token; defaults to CODEX_PROXY_API_KEY" },
  "web-search": { type: "bool", fallback: false, help: "always enable web search tool for requests; defaults to CODEX_PROXY_WEB_SEARCH" },
  provider: { type: "string", fallback: "codex", help: "upstream provider: codex or openai; defaults to CODEX_PROXY_PROVIDER" },
  upstream: { type: "string", fallback: "", help: "base URL for the openai provider, e.g. https://api.stepfun.ai/step_plan/v1" },
  "upstream-key": { type: "string", fallback: "", help: "bearer token for the openai provider; defaults to CODEX_PROXY_UPSTREAM_KEY" },
  "upstream-model": { type: "string", fallback: "", help: "force a model id for the openai provider instead of passing the client's through" },
  "reasoning-effort": { type: "string", fallback: "", help: "reasoning effort sent to the openai provider (low, medium, high)" },
  "max-turns": { type: "int", fallback: 256, help: "maximum agent loop turns per request; a runaway guard, not a working limit" },
  "discard-images": { type: "int", fallback: 0, help: "keep images from only the last N tool results (0 keeps all)" },
  config: { type: "string", fallback: "", help: "config.json describing several providers; defaults to CODEX_PROXY_CONFIG" },
};

export class HelpRequested extends Error {}

export function usageText() {
  const lines = ["Usage: codex-proxy [options]", "", "Options:"];
  for (const [name, spec] of Object.entries(flagSpec)) {
    const placeholder = spec.type === "bool" ? "" : ` <${spec.type === "int" ? "int" : "string"}>`;
    lines.push(`  --${name}${placeholder}\t${spec.help}`);
  }
  return lines.join("\n") + "\n";
}

function parseBool(value) {
  switch (value) {
    case "1":
    case "t":
    case "T":
    case "true":
    case "TRUE":
    case "True":
      return true;
    case "0":
    case "f":
    case "F":
    case "false":
    case "FALSE":
    case "False":
      return false;
    default:
      throw new Error(`invalid boolean value ${JSON.stringify(value)}`);
  }
}

// parseFlags mirrors Go's flag package closely enough for the documented CLI: one or two
// dashes, `--flag value` or `--flag=value`, and bare boolean flags.
export function parseFlags(args, env = process.env) {
  const cfg = {};
  for (const [name, spec] of Object.entries(flagSpec)) cfg[name] = spec.fallback;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      if (i + 1 < args.length) throw new Error(`unexpected argument ${JSON.stringify(args[i + 1])}`);
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    }

    let name = arg.startsWith("--") ? arg.slice(2) : arg.slice(1);
    if (name === "h" || name === "help") throw new HelpRequested();

    let inline;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    const spec = flagSpec[name];
    if (spec == null) throw new Error(`flag provided but not defined: -${name}`);

    if (spec.type === "bool") {
      cfg[name] = inline === undefined ? true : parseBool(inline);
      continue;
    }

    let value = inline;
    if (value === undefined) {
      i += 1;
      if (i >= args.length) throw new Error(`flag needs an argument: -${name}`);
      value = args[i];
    }
    if (spec.type === "int") {
      // Go's flag package uses strconv.Atoi: a plain decimal integer, no 1e3 or "  7 ".
      if (!/^[+-]?\d+$/.test(value.trim())) {
        throw new Error(`invalid value ${JSON.stringify(value)} for flag -${name}`);
      }
      cfg[name] = Number.parseInt(value.trim(), 10);
    } else {
      cfg[name] = value;
    }
  }

  if (cfg.port < 0 || cfg.port > 65535) throw new Error(`invalid --port ${cfg.port}`);
  if (cfg["api-key"] === "") cfg["api-key"] = env[apiKeyEnv] ?? "";
  if (cfg["api-key"] === "" && !isLoopbackHost(cfg.host)) {
    throw new Error(`refusing to listen on non-loopback host ${JSON.stringify(cfg.host)} without --api-key or ${apiKeyEnv}`);
  }
  if (!cfg["web-search"] && env[webSearchEnv]) {
    cfg["web-search"] = parseBoolEnv(env[webSearchEnv]);
  }
  for (const [name, envName] of Object.entries(providerEnvs)) {
    if (cfg[name] === "" && env[envName] !== undefined) cfg[name] = env[envName];
  }

  const provider = cfg.provider.toLowerCase();
  if (provider !== "codex" && provider !== "openai") {
    throw new Error(`unknown --provider ${JSON.stringify(cfg.provider)}; use codex or openai`);
  }
  if (provider === "openai" && cfg.upstream === "") {
    throw new Error("--provider openai requires --upstream or CODEX_PROXY_UPSTREAM");
  }

  return {
    host: cfg.host,
    port: cfg.port,
    codexHome: cfg["codex-home"],
    apiKey: cfg["api-key"],
    webSearch: cfg["web-search"],
    provider,
    upstream: cfg.upstream,
    upstreamKey: cfg["upstream-key"],
    upstreamModel: cfg["upstream-model"],
    reasoningEffort: cfg["reasoning-effort"],
    maxTurns: cfg["max-turns"],
    discardImages: cfg["discard-images"],
    config: cfg.config,
  };
}

export function parseBoolEnv(value) {
  switch (value.toLowerCase().trim()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

export function isLoopbackHost(host) {
  if (host.toLowerCase() === "localhost") return true;
  const kind = net.isIP(host);
  if (kind === 4) return host.startsWith("127.");
  if (kind === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1";
  return false;
}
