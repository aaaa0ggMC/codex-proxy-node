import path from "node:path";
import { documentId, openDocument, openDocumentFromBuffer, outlineOf, searchPages } from "../../src/docs/document.js";
import { CONTEXT_TOOL } from "../../src/context.js";
import { toolName } from "../../src/sdk.js";

// Documents the model can actually work with: text to search, pages to look at. Tools are the
// whole interface — nothing is injected into the prompt up front, so the context only grows when
// the model asks for something.

// The plugin owns its wire name. Every reference to one of its tools in prose is built through
// `ref`, which resolves through the same prefix the registry uses, so the text can never drift from
// the declarations and a prefix rename stays a one-line change in src/agent/names.js.
const NAME = "docs";
const NAMESPACE = true;
const ref = (tool) => toolName(NAME, tool, { namespace: NAMESPACE });

// Said on every open: the model only reaches for the slow, high-fidelity print when it is told it
// exists. It is a tail prompt, not a tool, so it costs nothing until a document is opened.
const PRINT_HINT = `\n\nTo see a page exactly as it prints — layout, charts, fonts — call ${ref("read_page")} with render: true (runs LibreOffice, slower). The default read gives the text and the pictures the file embeds.`;

const opened = new Map();
const MAX_OPEN = 8;
// A client that compacts its history loses the document id, so the model re-searches and re-opens.
// Document ids are content-derived, so the second open is the same document: remembering the
// descriptor turns that repeat into a map lookup instead of a re-parse of a multi-megabyte file.
const descriptors = new Map();

function resolve(reference) {
  const key = String(reference ?? "").trim();
  if (opened.has(key)) return opened.get(key);
  if (key === "") throw new Error(`a document reference is required; call ${ref("open")} first`);
  // Accept the id, a unique id prefix, or the file name, so a model that lost the id can still
  // refer to "the deck I just opened".
  // Models routinely drop the "doc_" prefix and quote only the hash, so match either part.
  const bare = (document) => document.id.replace(/^doc_/, "");
  const matches = [...opened.values()].filter(
    (document) => document.id.startsWith(key) || bare(document).startsWith(key) || document.name === key,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`document reference ${JSON.stringify(key)} is ambiguous; use the doc id`);
  // Listing what is open turns a dead end into something the model can recover from.
  const available = [...opened.values()].map((d) => `${d.id} (${d.name})`).join(", ");
  throw new Error(
    available === ""
      ? `no document is open; call ${ref("open")} first`
      : `no open document matches ${JSON.stringify(key)}; open documents: ${available}`,
  );
}


function remember(document, descriptor = "") {
  if (opened.size >= MAX_OPEN) {
    const evicted = opened.keys().next().value;
    opened.delete(evicted);
    descriptors.delete(evicted);
  }
  opened.set(document.id, document);
  if (descriptor !== "") descriptors.set(document.id, descriptor);
  return document;
}

// The page tools accept a path as well as an id, so recovering from a lost id is one call rather
// than search-then-open-then-read.
async function resolveOrOpen(reference, onProgress) {
  const key = String(reference ?? "").trim();
  if (!key.startsWith("/")) return resolve(key);
  const id = await documentId(key);
  if (opened.has(id)) return opened.get(id);
  return remember(await openDocument(key, { onProgress }));
}

// User-facing documentation for the console's plugin page. Plain Markdown; the console renders it
// with the small renderer in src/markdown.js.
const DOCS = [
  "# docs",
  "",
  "Give the model documents it can work with: text it can search, pages it can look at.",
  "",
  "    user: what does slide 3 of /sdcard/Download/deck.pptx say about churn?",
  `                                  └── ${ref("open")} turns the path into a document, then the model`,
  "                                      searches and reads just the page it needs",
  "",
  "## What it reads",
  "",
  "- `.pdf` — the text of every page, plus each page rendered as an image.",
  "- `.pptx` — each slide rendered to a picture: its shapes, text and pictures laid out together,",
  "  plus the slide text; speaker notes are kept separate.",
  "- `.docx` — one section, with its images.",
  "- `.xlsx` — one page per sheet, as a table in CSV form.",
  "- Images — `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`; one picture and no text.",
  "- Text and code — `.md`, `.txt`, `.csv`, `.json`, `.log`, `.srt`, `.yaml`, `.js`, `.py` and the",
  "  rest of the text extensions; one section holding the file's bytes.",
  "- Chat attachments, when the client sends them inline. A format it does not know is declined, so",
  "  another plugin may claim the file instead.",
  "",
  "## How it works",
  "",
  "- Nothing is read up front. A document enters the context only when the model opens it, so the",
  "  prompt stays small until something is actually needed.",
  "- Opening returns a `doc_` id and an outline: the kind, the page count and a preview of the text.",
  "  The id is derived from the file, so the same file always gives the same id and re-opening it is",
  "  a lookup rather than a second parse.",
  "- After the first open a document can be named by its id, by a unique prefix of its hash, by its",
  "  file name or by its path, so a model that lost the id can still ask for the deck it just",
  "  opened.",
  "- Eight documents are held at a time. When a ninth is opened the oldest is evicted, and opening",
  "  it again finds the same id, so eviction costs a lookup rather than a re-parse.",
  "",
  "## Tools",
  "",
  `- **\`${ref("open")} <path>\`** — open a local file and get its outline.`,
  `- **\`${ref("list")}\`** — the documents currently open.`,
  `- **\`${ref("search")} <doc> <query>\`** — which pages match, with snippets around each match.`,
  `- **\`${ref("read_page")} <doc> <page>\`** — one page's text, and its images unless \`images\` is false.`,
  "",
  "## Notes",
  "",
  "- Images are included by default, because a page of a deck is mostly its picture. Pass",
  "  `images: false` for text only and fewer tokens.",
  "- Speaker notes are off by default: they are what the presenter says, not what the page shows.",
  "  Pass `notes: true` when that is what you are after.",
  "- An attachment that arrives without inline data is reported rather than guessed at, since only",
  "  inline file data can be read.",
  "- The core automatically archives tool results and renews a reference in thinking. Keep that",
  `  thinking when replaying history. Large results are retrieved with \`${CONTEXT_TOOL}\`;`,
  "  checkpoint calls are optional. If the archive is unavailable, open the path again.",
  "",
].join("\n");

export default {
  name: NAME,
  namespace: NAMESPACE,
  docs: DOCS,
  // Chat attachments arrive as inline base64 rather than a path. Recognised ones become an open
  // document plus a short descriptor; anything else returns null so another plugin can try.
  async ingestFile({ filename, data }) {
    if (typeof data !== "string" || data === "") {
      return `[attachment ${filename} has no inline data; only file_data is supported, so it was not read]`;
    }
    let document;
    try {
      document = await openDocumentFromBuffer(filename, Buffer.from(data, "base64"));
    } catch (err) {
      // An unknown format is not ours to claim; a format we do know but cannot parse is worth saying.
      if (/unsupported document type/.test(err.message)) return null;
      return `[attachment ${filename} could not be read: ${err.message}]`;
    }
    remember(document);
    return `Attachment received as doc ${document.id}\n${await outlineOf(document, { readTool: ref("read_page") })}${PRINT_HINT}`;
  },
  tools: [
    {
      name: "open",
      description: "Open a local document and get its text. Reads .pdf, .pptx, .docx, .xlsx, images, and text files such as .md, .txt, .csv and source code. Reopening the same file returns the same id and costs nothing. A document can be referred to afterwards by its id, its hash, its file name, or its path.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path to the file" } },
        required: ["path"],
      },
      timeoutMs: 120_000,
      async run({ path }, ctx) {
        if (typeof path !== "string" || path.trim() === "") throw new Error("path is required");
        const id = await documentId(path);
        const cached = descriptors.get(id);
        if (cached != null) return cached;
        const document = remember(await openDocument(path, { onProgress: ctx?.progress }));
        const descriptor = `doc ${document.id}\n${await outlineOf(document, { readTool: ref("read_page") })}${PRINT_HINT}`;
        descriptors.set(document.id, descriptor);
        return descriptor;
      },
    },
    {
      name: "list",
      description: "List the documents currently open.",
      parameters: { type: "object", properties: {} },
      async run() {
        if (opened.size === 0) return "no documents are open";
        return [...opened.values()]
          .map((d) => `${d.id}  ${d.name}  ${d.kind}  ${d.pageCount} ${d.pageLabel}s`)
          .join("\n");
      },
    },
    {
      name: "search",
      description: "Find text in an open document. Returns page numbers and matching snippets.",
      parameters: {
        type: "object",
        properties: {
          doc: { type: "string", description: `Document id from ${ref("open")} (a unique prefix is fine)` },
          query: { type: "string" },
          limit: { type: "number", description: "Maximum pages to report, default 8" },
        },
        required: ["doc", "query"],
      },
      timeoutMs: 120_000,
      async run({ doc, query, limit }, ctx) {
        const document = await resolveOrOpen(doc, ctx?.progress);
        const pages = [];
        for (let page = 1; page <= document.pageCount; page++) pages.push(await document.text(page));
        const hits = searchPages(pages, String(query ?? ""), Number(limit) > 0 ? Number(limit) : 8);
        if (hits.length === 0) return `no matches for ${JSON.stringify(query)} in ${document.name}`;
        return hits
          .map((hit) => `${document.pageLabel} ${hit.page}:\n  ${hit.snippets.join("\n  ")}`)
          .join("\n");
      },
    },
    {
      name: "read_page",
      description: "Read one page of an open document: its text, plus its images so you can look at it. .pdf and .pptx are visual pages (a .pptx slide is rendered); a .docx/.xlsx is read as text plus its embedded pictures. Set render: true to print the page with LibreOffice instead — truest formatting, slower.",
      parameters: {
        type: "object",
        properties: {
          doc: { type: "string", description: `Document id from ${ref("open")}` },
          page: { type: "number", description: "1-based page or slide number" },
          images: { type: "boolean", description: "Set false to skip images and save tokens" },
          notes: { type: "boolean", description: "Include the slide speaker notes. Off by default, because notes are not what is on the page." },
          render: { type: "boolean", description: "Print this page as a picture with LibreOffice (Word, Excel, PowerPoint). Slow — it runs LibreOffice; off by default. A .pptx page is already a fast rendered slide by default; render: true asks LibreOffice for the truest layout of this one slide." },
        },
        required: ["doc", "page"],
      },
      timeoutMs: 240_000,
      async run({ doc, page, images, notes, render }, ctx) {
        const document = await resolveOrOpen(doc, ctx?.progress);
        const number = Number(page);
        if (!Number.isInteger(number) || number < 1 || number > document.pageCount) {
          throw new Error(`page must be an integer between 1 and ${document.pageCount}`);
        }
        if (images === true && document.imageSupport === false) {
          throw new Error(
            `${document.kind} has no pages to render; drop images, or use a format that has them (.pdf, .pptx, .docx, an image file)`,
          );
        }
        const text = (await document.text(number)).trim();
        let body = text || "(no text on this page)";
        if (notes === true) {
          const speaker = (await document.notes(number)).trim();
          if (speaker !== "") body += `\n\n--- speaker notes (not on the slide) ---\n${speaker}`;
        }
        const parts = [
          {
            type: "input_text",
            text: `${document.name} ${document.pageLabel} ${number}/${document.pageCount}\n\n${body}`,
          },
        ];
        if (images === false) return parts;
        const media = await document.images(number, { render, onProgress: ctx?.progress });
        if (render === true && media.length === 0) {
          parts.push({ type: "input_text", text: "[LibreOffice print produced no page images; read as text only]" });
        }
        for (const image of media) {
          parts.push({ type: "input_image", image_url: `data:${image.mime};base64,${image.base64}`, detail: "high" });
        }
        return parts;
      },
    },
  ],
};
