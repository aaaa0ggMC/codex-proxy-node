// Answer image references: the model may show the user a picture with markdown image syntax, and it
// may say whether the picture should stay visible to it on later turns:
//
//	![alt|visible](src)     the user sees it, and the model sees it again on replay
//	![alt|invisible](src)   the user sees it, the model does not (the default)
//	![alt](src)             same as invisible
//
// `src` is an http(s) URL, a data: URI, or a handle the proxy minted for an image a tool returned.
// Who resolves it is a plugin (see plugins/image-design); this module only finds the spans and
// buffers them across streamed chunks, the same way FenceRewriter buffers a fenced block.

const IMAGE = /^!\[([^\]]*)\]\(([^)]*)\)/;

export function parseImageAlt(alt) {
  const match = /^(.*?)\|(visible|invisible)\s*$/i.exec(String(alt ?? ""));
  if (match == null) return { alt: String(alt ?? ""), visible: false };
  return { alt: match[1].trim(), visible: match[2].toLowerCase() === "visible" };
}

// matchImage classifies the text at an "![" position: a complete image, more needed, or not an
// image at all (so the "!" is ordinary text and scanning resumes after it).
function matchImage(text) {
  const close = text.indexOf("]", 2);
  if (close === -1) return { kind: "incomplete" };
  if (text[close + 1] !== "(") return { kind: "text" };
  const end = text.indexOf(")", close + 2);
  if (end === -1) return { kind: "incomplete" };
  const match = IMAGE.exec(text.slice(0, end + 1));
  if (match == null) return { kind: "text" };
  return { kind: "image", alt: match[1], src: match[2], raw: text.slice(0, end + 1) };
}

// ImageRefRewriter replaces each image reference with whatever the resolver returns. A null result
// leaves the reference untouched, so a plugin that does not understand a source cannot break it.
export class ImageRefRewriter {
  #resolve;
  #pending = "";

  constructor(resolve) {
    this.#resolve = typeof resolve === "function" ? resolve : () => null;
  }

  feed(chunk) {
    if (typeof chunk !== "string" || chunk === "") return { text: "" };
    this.#pending += chunk;
    let out = "";
    while (this.#pending !== "") {
      const start = this.#pending.indexOf("![");
      if (start === -1) {
        const keep = this.#pending.endsWith("!") ? 1 : 0;
        out += this.#pending.slice(0, this.#pending.length - keep);
        this.#pending = this.#pending.slice(this.#pending.length - keep);
        break;
      }
      out += this.#pending.slice(0, start);
      const rest = this.#pending.slice(start);
      const found = matchImage(rest);
      if (found.kind === "incomplete") {
        this.#pending = rest;
        break;
      }
      if (found.kind === "text") {
        out += "!";
        this.#pending = rest.slice(1);
        continue;
      }
      const { alt, visible } = parseImageAlt(found.alt);
      const replaced = this.#resolve({ alt, visible, src: found.src });
      out += typeof replaced === "string" ? replaced : found.raw;
      this.#pending = rest.slice(found.raw.length);
    }
    return { text: out };
  }

  flush() {
    const rest = this.#pending;
    this.#pending = "";
    return { text: rest };
  }
}
