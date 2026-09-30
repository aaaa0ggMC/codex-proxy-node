import { HANDLE, getImage, mediaUrl, parseDataURI, putImage } from "../../src/media.js";
import { parseImageAlt } from "../../src/images.js";


// Images the model shows the user, processed as references rather than pixels in the prompt.
//
// The model writes a markdown image with a visibility flag; this plugin resolves the source (an
// http(s) URL, a data: URI, or an `img_...` handle a tool handed it), rewrites it to something the
// client can render, and — on the way back in — hands a `visible` image back as pixels while an
// `invisible` one is replaced by a receipt saying what was delivered. It declares no tools:
// everything happens in the answer stream.
//
//	![cover|visible](img_ab12)      the user sees it, and the model sees it again on replay
//	![cover|invisible](img_ab12)    the user sees it, the model does not (the default)
//
// Outbound the flag becomes a URL fragment (`.../media/img_ab12#invisible`), which the client never
// sends and the user never sees, but which keeps the disposition self-describing across a restart —
// no server-side per-image state to drift.

const INSTRUCTIONS = [
  "To show the user a picture, write a markdown image with a visibility flag:",
  "`![what it is|visible](src)` if you must see it again on later turns, or",
  "`![what it is|invisible](src)` (the default) when only the user should see it.",
  "`src` may be an http(s) URL, a `data:image/...;base64,...` URI, or an `img_...` handle a tool",
  "result gave you. Never write an image with an empty or placeholder src — that shows the user a",
  "broken image; if you only have a handle, pass the handle.",
  "On later turns your own message reads `[sent image: what it was (img_ab12)]` where you wrote an",
  "invisible image: that picture reached the user, so say so plainly — its bytes are absent from",
  "your context on purpose, not because the image failed. `[image link: what it was (url)]` is",
  "weaker: it only records an outside URL the proxy passed on without storing it.",
].join(" ");

// User-facing documentation for the console's plugin page.
const DOCS = [
  "# image-design",
  "",
  "Handles the pictures the model shows you, without any tool of its own.",
  "",
  "- `![alt|visible](src)` — you see it, and the model sees it again on later turns.",
  "- `![alt|invisible](src)` — you see it; the model does not (the default when the flag is absent).",
  "- `src` is an http(s) URL, a `data:` URI, or an `img_...` handle from a tool result.",
  "",
  "A handle comes from a tool that returned an image (for example a rendered page): the proxy mints",
  "it and mentions it in the tool result, so the model can refer back to the picture in one short",
  "token instead of pasting base64. An `img_...` source is stored and served under `/media/<id>`.",
  "",
  "On replay, an `invisible` image becomes a short receipt — `[sent image: what it was (img_ab12)]`"
  + " when the proxy stored the bytes and serves them itself, `[image link: what it was (url)]` when",
  "it only passed an outside URL along. The model never re-reads the picture, but it can tell what",
  "reached you and how far the proxy can vouch for it. A `visible` one is handed back as a picture,",
  "and a reference the proxy never rewrote is left exactly as the model wrote it.",
  "",
].join("\n");

export default {
  name: "image-design",
  namespace: false,
  docs: DOCS,
  instructions: INSTRUCTIONS,
  images: {
    resolve({ alt, visible, src }, { origin } = {}) {
      const resolved = resolveSource(src, origin);
      if (resolved == null) return null;
      return `![${alt}](${resolved}#${visible ? "visible" : "invisible"})`;
    },
  },
  // Keep a visible image as a picture for the model, and replace an invisible one the outbound pass
  // rewrote with a receipt, so the model can tell a picture it actually sent from a caption that
  // never carried one. Anything the proxy never rewrote stays as the model wrote it.
  restoreText(text) {
    return String(text ?? "").replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (raw, alt, src) => {
      // The fragment is written by the outbound pass alone, so without it the model's own text is
      // already faithful: the proxy never rewrote this reference and must not rewrite it now.
      if (!wasResolved(src)) return raw;
      if (viewVisibility(src)) return raw;
      // The picture bytes are gone (that is the token saving), but the delivery itself is not: a
      // bare alt reads exactly like a caption the model wrote without attaching anything, leaving
      // it unable to say whether the user ever got the picture.
      return receipt(alt, src);
    });
  },
  // A visible image must come back as pixels, not a URL, so a replay re-attaches it as a picture.
  contribute({ input }) {
    const images = [];
    for (const item of input ?? []) {
      if (item?.role !== "assistant") continue;
      for (const text of textsOf(item.content)) {
        for (const match of text.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)) {
          if (!viewVisibility(match[2])) continue;
          const image = imageBytesOf(match[2]);
          if (image != null) images.push(image);
        }
      }
    }
    if (images.length === 0) return null;
    const parts = [{ type: "input_text", text: "Pictures you kept visible, as you saw them:" }];
    for (const image of images) {
      parts.push({ type: "input_image", image_url: `data:${image.mime};base64,${image.base64}`, detail: "high" });
    }
    return { append: [{ role: "developer", content: parts }] };
  },
};

// resolveSource turns whatever the model wrote into something a client can fetch. A data: URI or
// handle becomes a `/media/<id>` URL (a network image, so no data:-in-markdown quirks); a plain
// http(s) URL is already fetchable and passes through.
function resolveSource(src, origin) {
  const value = String(src ?? "").trim();
  if (value === "") return null;
  const data = parseDataURI(value);
  if (data != null) {
    const id = putImage(data.base64, data.mime);
    return id == null ? null : mediaUrl(origin, id);
  }
  if (HANDLE.test(value)) return getImage(value) == null ? null : mediaUrl(origin, value);
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

// viewVisibility reads the fragment the outbound pass wrote. A replayed assistant message is the
// only place it is parsed, so the markdown the user sees carries no flag in its alt text.
function viewVisibility(src) {
  return /#visible\s*$/i.test(String(src ?? ""));
}

// receipt is the cheap stand-in the model sees on replay for a picture the proxy rewrote on its way
// out. It claims only what the proxy can vouch for: a handle it stored and serves under /media/ was
// delivered, while an outside URL was merely passed along and may never have loaded for the user.
function receipt(alt, src) {
  const full = parseImageAlt(alt).alt;
  const label = full === "" ? "" : `: ${full.length > 80 ? `${full.slice(0, 79)}\u2026` : full}`;
  const handle = handleOf(src);
  if (handle != null) return `[sent image${label} (${handle})]`;
  const url = urlOf(src);
  if (url != null) return `[image link${label} (${url})]`;
  return `[image${label}]`;
}

// wasResolved reads the fragment the outbound pass wrote (see viewVisibility): it is the only mark
// that distinguishes a reference this plugin rewrote from one the model wrote and we left alone.
function wasResolved(src) {
  return /#(visible|invisible)\s*$/i.test(String(src ?? ""));
}

// The fragment is transport metadata for the disposition, never part of the source, so drop it
// before reading the source itself.
function sourceOf(src) {
  return String(src ?? "").trim().replace(/#[^#]*$/, "");
}

function handleOf(src) {
  const value = sourceOf(src);
  if (HANDLE.test(value)) return value;
  return /\/media\/(img_[a-f0-9]+)\b/i.exec(value)?.[1] ?? null;
}

function urlOf(src) {
  const value = sourceOf(src);
  return /^https?:\/\//i.test(value) ? value : null;
}

function imageBytesOf(src) {
  const value = String(src ?? "").trim();
  const data = parseDataURI(value);
  if (data != null) return { base64: data.base64, mime: data.mime };
  const id = /\/media\/(img_[a-f0-9]+)/i.exec(value)?.[1];
  if (id == null) return null;
  const image = getImage(id);
  return image == null ? null : { base64: image.bytes.toString("base64"), mime: image.mime };
}

function textsOf(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((part) => typeof part?.text === "string").map((part) => part.text);
}
