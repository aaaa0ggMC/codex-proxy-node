import path from "node:path";
import { documentId, openDocument, openDocumentFromBuffer, outlineOf, searchPages } from "../../src/docs/document.js";

// Documents the model can actually work with: text to search, pages to look at. Tools are the
// whole interface — nothing is injected into the prompt up front, so the context only grows when
// the model asks for something.

const opened = new Map();
const MAX_OPEN = 8;
// A client that compacts its history loses the document id, so the model re-searches and re-opens.
// Document ids are content-derived, so the second open is the same document: remembering the
// descriptor turns that repeat into a map lookup instead of a re-parse of a multi-megabyte file.
const descriptors = new Map();

function resolve(reference) {
  const key = String(reference ?? "").trim();
  if (opened.has(key)) return opened.get(key);
  if (key === "") throw new Error("a document reference is required; call docs__open first");
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
      ? `no document is open; call docs__open first`
      : `no open document matches ${JSON.stringify(key)}; open documents: ${available}`,
  );
}


// A checkpoint is the one thing worth keeping across a client's history compaction: which file the
// id refers to. It rides the thinking channel out and is lifted back in as context (checkpoints.js).
function checkpointSuffix(document, source = "") {
  // The path is the point: with it the model can reopen the document directly instead of searching
  // again to rediscover where it was.
  const where = source !== "" ? source : document.name;
  return `\n<checkpoint>${document.id} = ${where} (${document.pageCount} ${document.pageLabel}s)</checkpoint>`;
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
async function resolveOrOpen(reference) {
  const key = String(reference ?? "").trim();
  if (!key.startsWith("/")) return resolve(key);
  const id = await documentId(key);
  if (opened.has(id)) return opened.get(id);
  return remember(await openDocument(key));
}

export default {
  name: "docs",
  namespace: true,
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
    return `Attachment received as doc ${document.id}\n${(await outlineOf(document)) + checkpointSuffix(document)}`;
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
      async run({ path }) {
        if (typeof path !== "string" || path.trim() === "") throw new Error("path is required");
        const id = await documentId(path);
        const cached = descriptors.get(id);
        if (cached != null) return cached;
        const document = remember(await openDocument(path));
        const descriptor = `doc ${document.id}\n${(await outlineOf(document)) + checkpointSuffix(document, path)}`;
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
          doc: { type: "string", description: "Document id from docs__open (a unique prefix is fine)" },
          query: { type: "string" },
          limit: { type: "number", description: "Maximum pages to report, default 8" },
        },
        required: ["doc", "query"],
      },
      timeoutMs: 120_000,
      async run({ doc, query, limit }) {
        const document = await resolveOrOpen(doc);
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
      description: "Read one page of an open document: its text, plus its images so you can look at it. .pdf and .pptx have images; .docx is a single section.",
      parameters: {
        type: "object",
        properties: {
          doc: { type: "string", description: "Document id from docs__open" },
          page: { type: "number", description: "1-based page or slide number" },
          images: { type: "boolean", description: "Set false to skip images and save tokens" },
          notes: { type: "boolean", description: "Include the slide speaker notes. Off by default, because notes are not what is on the page." },
        },
        required: ["doc", "page"],
      },
      timeoutMs: 120_000,
      async run({ doc, page, images, notes }) {
        const document = await resolveOrOpen(doc);
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
        for (const image of await document.images(number)) {
          parts.push({ type: "input_image", image_url: `data:${image.mime};base64,${image.base64}`, detail: "high" });
        }
        return parts;
      },
    },
  ],
};
