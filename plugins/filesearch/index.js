import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { toolName } from "../../src/sdk.js";

// The plugin owns its wire name; prose references are built through `ref`, and a sibling plugin
// is referenced by its own name too, so the prefix lives only in src/agent/names.js.
const NAME = "filesearch";
const NAMESPACE = true;
const ref = (tool) => toolName(NAME, tool, { namespace: NAMESPACE });
const docsOpen = toolName("docs", "open");

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


// A read tool must not become a way out of the configured roots, so every path is resolved and
// checked against them before anything is opened.
function withinRoots(target) {
  const resolved = path.resolve(target);
  return ROOTS.some((root) => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

const TEXT_EXTENSIONS = [".md", ".markdown", ".txt", ".json", ".jsonl", ".csv", ".tsv", ".log", ".srt", ".yaml", ".yml", ".toml", ".ini", ".xml", ".html", ".css", ".js", ".mjs", ".ts", ".py", ".sh", ".go", ".rs", ".java", ".c", ".h", ".cpp"];
const MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_LINES = 400;
const MAX_LINES = 2000;

// User-facing documentation for the console's plugin page. Plain Markdown; the console renders it
// with the small renderer in src/markdown.js.
const DOCS = [
  "# filesearch",
  "",
  "Find a file by name when nobody remembers where it went, and read it as text.",
  "",
  "    CODEX_PROXY_FILE_ROOTS=/storage/emulated/0/Download:/storage/emulated/0/Documents",
  "    user: find the notes about the camping trip",
  `          └── a ranked list of paths, then ${ref("read")} opens one as text`,
  "",
  "## Roots",
  "",
  "- Search only ever looks under the folders in `CODEX_PROXY_FILE_ROOTS`, colon-separated. Unset,",
  "  it defaults to `Download` and `Documents` on shared storage.",
  "- Every returned path is under one of those roots, and the plugin never writes anything: it is",
  "  read-only by design.",
  "",
  "## Tools",
  "",
  `- **\`${ref("search")} <query>\`** — a fuzzy match on the file name first, then on the whole`,
  "  path. Ranked best first; `limit` asks for at most 20 results, 8 by default.",
  `- **\`${ref("read")} <path>\`** — one window of lines of a text file: \`from_line\` (default 1) and`,
  "  `lines` (default 400, at most 2000). Files up to 2MB.",
  "",
  "## Notes",
  "",
  "- There is no directory listing and no way to walk a tree. The index behind the search is",
  "  bounded: four levels of nesting, twenty thousand entries, refreshed once a minute.",
  "- Hidden entries are skipped, and a folder that cannot be read is skipped rather than failing",
  "  the whole search.",
  `- It reads text only. For \`.pdf\`, \`.pptx\` and the other document formats use \`${docsOpen}\`, which`,
  "  handles images and pagination.",
  "- A binary file is refused rather than printed as garbage.",
  "",
].join("\n");

export default {
  name: NAME,
  namespace: NAMESPACE,
  docs: DOCS,
  tools: [
    {
      name: "search",
      description:
        `Find files by fuzzy name or partial path. Read-only, restricted to the configured folders, and there is no way to list a directory. A hit can be opened: use ${ref("read")} for text files and ${docsOpen} for .pdf and .pptx. It cannot read file contents by itself.`,
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
    {
      name: "read",
      description:
        `Read a text file by path, one window of lines at a time. Read-only and restricted to the configured folders. Use this for .md, .txt, .json, .csv, .log, .srt and source code. It cannot read .pdf or .pptx — use ${docsOpen} for those.`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: `Absolute path, as returned by ${ref("search")}` },
          from_line: { type: "number", description: "1-based first line, default 1" },
          lines: { type: "number", description: "How many lines, default 400" },
        },
        required: ["path"],
      },
      timeoutMs: 30_000,
      async run({ path: target, from_line, lines }) {
        if (typeof target !== "string" || target.trim() === "") throw new Error("path is required");
        if (!withinRoots(target)) {
          throw new Error(`refusing to read outside ${ROOTS.join(", ")}`);
        }
        const extension = path.extname(target).toLowerCase();
        if (!TEXT_EXTENSIONS.includes(extension)) {
          throw new Error(
            `${ref("read")} cannot read ${extension || "a file without an extension"}; it handles text. For .pdf and .pptx use ${docsOpen}.`,
          );
        }
        const info = await stat(target).catch(() => null);
        if (info == null || !info.isFile()) throw new Error(`no such file: ${target}`);
        if (info.size > MAX_READ_BYTES) {
          throw new Error(`file is ${human(info.size)}, larger than the ${human(MAX_READ_BYTES)} limit`);
        }

        const body = await readFile(target, "utf8");
        if (body.includes("\u0000")) throw new Error("this looks like a binary file, not text");
        const all = body.split("\n");
        const start = Number.isInteger(Number(from_line)) && Number(from_line) > 0 ? Number(from_line) : 1;
        const count = Number.isInteger(Number(lines)) && Number(lines) > 0 ? Math.min(Number(lines), MAX_LINES) : DEFAULT_LINES;
        const window = all.slice(start - 1, start - 1 + count);
        const shownTo = start - 1 + window.length;
        const more = shownTo < all.length ? ` (${all.length - shownTo} more lines; call again with from_line=${shownTo + 1})` : "";
        return `${target} — lines ${start}-${shownTo} of ${all.length}${more}\n\n${window.join("\n")}`;
      },
    },
  ],
};
