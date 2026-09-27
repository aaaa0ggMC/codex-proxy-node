import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ToolRegistry } from "../agent/tools.js";

// Plugins are drop-in folders: create plugins/<name>/index.js, default-export the plugin, and its
// tools are offered to the model on the next start. Nothing registers by hand.
//
//	export default {
//	  name: "docs",
//	  namespace: true,                       // optional: prefix tools with "docs__"
//	  instructions: "…",                     // optional: a Skill's prompt fragment
//	  ingest: async (parts, ctx) => parts,   // optional: rewrite attachment content
//	  tools: [{ name, description, parameters, run, timeoutMs }],
//	}

// Two ways to keep a folder out of the way, both by name so nothing has to be moved:
//   _name / .name  silently skipped (the shipped example, or anything hidden)
//   -name          deliberately disabled; logged, so a rename is visibly confirmed
const IGNORED_PREFIX = /^[_.]/;
const DISABLED_PREFIX = /^-/;

export async function loadPlugins(dir, { log } = {}) {
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  // Sorted, so the tool declarations go out in the same order on every request. Prompt prefixes
  // are what the provider caches, so a nondeterministic order would cost cache hits.
  const folders = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    if (IGNORED_PREFIX.test(entry.name)) continue;
    if (DISABLED_PREFIX.test(entry.name)) {
      log?.info("plugin disabled by name", { plugin: entry.name, rename: entry.name.replace(/^-/, "") });
      continue;
    }
    folders.push(entry.name);
  }
  folders.sort();

  const plugins = [];
  for (const folder of folders) {
    const entry = path.join(dir, folder, "index.js");
    try {
      const mod = await import(pathToFileURL(entry).href);
      const plugin = typeof mod.default === "function" ? await mod.default() : mod.default;
      if (plugin == null || typeof plugin !== "object") {
        throw new Error("a plugin must default-export an object");
      }
      plugins.push(plugin);
    } catch (err) {
      // One broken plugin must not stop the proxy from serving; report and move on.
      log?.error("plugin failed to load", { plugin: folder, error: err.message });
    }
  }
  return plugins;
}

// buildRegistry turns loaded plugins into one registry, still skipping any that misbehave when
// their tools are registered.
export function buildRegistry(plugins, { log } = {}) {
  const registry = new ToolRegistry();
  for (const plugin of plugins) {
    try {
      registry.register(plugin);
    } catch (err) {
      log?.error("plugin was rejected", { plugin: plugin?.name, error: err.message });
    }
  }
  return registry;
}
