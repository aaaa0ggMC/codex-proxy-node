// A deliberately small Markdown renderer for plugin and tool documentation.
//
// It covers what a doc page actually uses — headings, code, lists, quotes, rules, links, bold and
// italic — and nothing else. HTML is escaped first, so a document can never inject markup, and the
// subset is small enough to audit in one sitting.

const BLOCK_START = /^(#{1,6}\s|```|~~~|>\s?|\s*([-*+]|\d+[.)])\s+|\s*(---|\*\*\*|___)\s*$)/;

export function renderMarkdown(source) {
  const text = String(source ?? "").replace(/\r\n?/g, "\n");
  if (text.trim() === "") return "";

  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*(```|~~~)(\w*)\s*$/.exec(line);
    if (fence != null) {
      const close = fence[1];
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${close}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // the closing fence (or end of input)
      out.push(`<pre><code>${escapeHTML(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Four-space indented block: literal text, the way Markdown has always done it.
    if (/^ {4}/.test(line)) {
      const body = [];
      while (i < lines.length) {
        if (lines[i].trim() === "" && !/^ {4}/.test(lines[i + 1] ?? "")) break;
        body.push(lines[i].replace(/^ {4}/, ""));
        i += 1;
      }
      out.push(`<pre><code>${escapeHTML(body.join("\n").replace(/\n+$/, ""))}</code></pre>`);
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading != null) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+/.exec(line);
    const numbered = /^(\s*)\d+[.)]\s+/.exec(line);
    if (bullet != null || numbered != null) {
      const tagged = bullet != null ? "ul" : "ol";
      const marker = bullet != null ? /^\s*[-*+]\s+/ : /^\s*\d+[.)]\s+/;
      const items = [];
      while (i < lines.length && marker.test(lines[i])) {
        let text = lines[i].replace(marker, "");
        i += 1;
        // A wrapped continuation line belongs to the item it follows.
        while (
          i < lines.length &&
          lines[i].trim() !== "" &&
          !marker.test(lines[i]) &&
          !/^\s*(#{1,6}\s|\`\`\`|~~~|>\s?)/.test(lines[i])
        ) {
          text += " " + lines[i].trim();
          i += 1;
        }
        items.push(text);
      }
      out.push(`<${tagged}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tagged}>`);
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== "" && (paragraph.length === 0 || !BLOCK_START.test(lines[i]))) {
      paragraph.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }

  return out.join("\n");
}

function inline(text) {
  let out = escapeHTML(text);
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  out = out.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()]*\))*)\)/g, (_, label, url) => {
    const href = safeURL(url);
    return href === "" ? label : `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  return out;
}

// Only links that cannot run code: absolute http(s)/mailto, fragments and relative paths.
function safeURL(url) {
  const value = String(url ?? "").trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (/^[#/.]/.test(value)) return value;
  return "";
}

export function escapeHTML(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
