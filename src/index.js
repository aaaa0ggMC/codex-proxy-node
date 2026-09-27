#!/usr/bin/env node
import dns from "node:dns";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { HelpRequested, parseFlags, usageText } from "./config.js";
import { TokenSource } from "./auth.js";
import { createProvider } from "./providers/index.js";
import { ProviderRegistry, loadProviderConfig } from "./providers/registry.js";
import { Server } from "./server.js";
import { usageTTLFromEnv } from "./usage.js";
import { createLoggerTo } from "./log.js";
import { buildRegistry, loadPlugins } from "./plugins/loader.js";
import { loadDisabledPlugins } from "./admin.js";
import { setImageMaxEdge } from "./docs/settings.js";

// Prefer IPv4 when resolving the upstream. Go's dialer does happy-eyeballs and falls back on its
// own, but Node connects to the first address DNS hands back; on dual-stack and fake-IP (TUN)
// networks that is often an unroutable AAAA record, which shows up as "fetch failed". Ordering
// IPv4 first matches what the Go binary does in practice. Override with
// NODE_OPTIONS=--dns-result-order=verbatim if your host really is IPv6-only.
dns.setDefaultResultOrder("ipv4first");

async function main(argv) {
  let cfg;
  try {
    cfg = parseFlags(argv);
  } catch (err) {
    if (err instanceof HelpRequested) {
      process.stdout.write(usageText());
      return;
    }
    process.stderr.write(`codex-proxy: ${err.message}\n`);
    process.stderr.write(usageText());
    process.exitCode = 1;
    return;
  }

  const log = createLoggerTo(process.stderr);
  setImageMaxEdge(cfg.imageMaxEdge);
  const tokens = new TokenSource({ codexHome: cfg.codexHome });

  // Either one provider from the CLI flags, or several from config.json. The registry presents
  // both cases to the server as a single provider.
  const configPath = cfg.config !== "" ? cfg.config : existsSync("config.json") ? "config.json" : "";
  let provider;
  if (configPath !== "") {
    const loaded = await loadProviderConfig(configPath, { log, tokens });
    if (loaded.providers.length === 0) throw new Error(`${configPath} did not enable any provider`);
    provider = new ProviderRegistry({ ...loaded, log });
    log.info("providers loaded", { config: configPath, providers: provider.names() });
  } else {
    provider = createProvider(cfg, { tokens });
  }

  // Plugins are discovered once, at start. Reloading them mid-flight would change the tool
  // declarations and so invalidate every conversation's cached prompt prefix.
  const pluginsDir = path.join(import.meta.dirname, "..", "plugins");
  const registry = buildRegistry(await loadPlugins(pluginsDir, { log }), { log });
  const toolCount = registry.names().size;
  if (toolCount > 0) log.info("plugins loaded", { tools: toolCount });

  // A plugin switched off from the admin page stays off across restarts.
  const pluginStateFile = path.join(import.meta.dirname, "..", "plugins-state.json");
  for (const name of await loadDisabledPlugins(pluginStateFile)) {
    if (registry.pluginNames().includes(name)) registry.setEnabled(name, false);
  }

  const server = new Server({
    provider,
    log,
    apiKey: cfg.apiKey,
    webSearch: cfg.webSearch,
    usageTTL: usageTTLFromEnv(),
    registry,
    pluginStateFile,
    maxTurns: cfg.maxTurns,
    discardImages: cfg.discardImages,
  });

  const httpServer = http.createServer(server.handler());
  // Codex streams long answers, so no whole-request timeout (matching the Go server, which only
  // bounds header reads).
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 10_000;

  httpServer.on("error", (err) => {
    process.stderr.write(`codex-proxy: ${err.message}\n`);
    process.exit(1);
  });

  httpServer.listen(cfg.port, cfg.host, () => {
    process.stderr.write(`listening on http://${cfg.host}:${cfg.port}\n`);
  });
}

await main(process.argv.slice(2));
