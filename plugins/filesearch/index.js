import { readdir, stat } from "node:fs/promises";
import path from "node:path";

// Read-only file search, deliberately without a listing tool.
//
// The model can ask "which file matches this", but it cannot enumerate a directory, walk a tree, or
// reach outside the configured roots: the roots are fixed here, the scan depth and entry count are
// bounded, and every result is a path under one of those roots. Nothing in this plugin writes.

const ROOTS = (process.env.CODEX_PROXY_FILE_ROOTS ?? "/storage/emulated/0/Download:/storage/emulated/0/Documents")
  .split(":")
  .map((root) => root.trim())
  .filter(Boolean);

const MAX_DEPTH = 4;
const MAX_ENTRIES = 20_000;
const INDEX_TTL_MS = 60_000;

let cache = { at: 0, files: [] };

async function walk(dir, depth, files) {
  if (files.length >= MAX_ENTRIES || depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory (permissions, Android scoping): skip it, do not fail the search
  }
  for (const entry of entries) {
    if (files.length >= MAX_ENTRIES) return;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, depth + 1, files);
    else if (entry.isFile()) files.push(full);
  }
}

async function index() {
  if (Date.now() - cache.at < INDEX_TTL_MS) return cache.files;
  const files = [];
  for (const root of ROOTS) await walk(root, 0, files);
  cache = { at: Date.now(), files };
  return files;
}

// score is a small, predictable fuzzy matcher: exact name, then name substring, then path
// substring, then a subsequence, then all tokens present anywhere. Zero means "not a match".
export function score(filePath, query) {
  const name = path.basename(filePath).toLowerCase();
  const full = filePath.toLowerCase();
  const q = String(query ?? "").toLowerCase().trim();
  if (q === "") return 0;
  if (name === q) return 1000;
  if (name.includes(q)) return 800 - name.length / 1000;
  if (full.includes(q)) return 600 - full.length / 10_000;
  let cursor = 0;
  for (const character of name) {
    if (cursor < q.length && q[cursor] === character) cursor += 1;
  }
  if (cursor === q.length) return 400;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => full.includes(token))) return 200;
  return 0;
}

export function rank(files, query, limit) {
  return files
    .map((file) => ({ file, points: score(file, query) }))
    .filter((entry) => entry.points > 0)
    .sort((a, b) => b.points - a.points || a.file.length - b.file.length)
    .slice(0, limit);
}

function human(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export default {
  name: "filesearch",
  namespace: true,
  tools: [
    {
      name: "search",
      description:
        "Find files by fuzzy name or partial path. Read-only and restricted to the configured folders; there is no way to list a directory. The returned path can be passed to docs__open.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Part of a file name or path, e.g. 'QQ/装在套子里的豆包'" },
          limit: { type: "number", description: "Maximum results, default 8" },
        },
        required: ["query"],
      },
      timeoutMs: 60_000,
      async run({ query, limit }) {
        const wanted = Number(limit) > 0 ? Math.min(Number(limit), 20) : 8;
        const files = await index();
        const hits = rank(files, query, wanted);
        if (hits.length === 0) {
          return `No file under ${ROOTS.join(", ")} matches ${JSON.stringify(query)}. This plugin can only search those folders and cannot list directories.`;
        }
        const lines = [];
        for (const hit of hits) {
          let size = "";
          try {
            size = human((await stat(hit.file)).size);
          } catch {
            size = "?";
          }
          lines.push(`${hit.file}  (${size})`);
        }
        return lines.join("\n");
      },
    },
  ],
};
