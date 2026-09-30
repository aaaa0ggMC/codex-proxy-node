import { measure } from "./layout.js";

// Turns a laid-out graph into one standalone SVG string. No external assets: everything a viewer
// needs (fonts, markers, the shadow filter) is inline, so the image renders the same anywhere.

export function renderFlowchart(graph, layout, theme) {
  if (layout.nodes.length === 0) return renderEmpty(theme);

  // Ids only need to be stable for one picture and unique enough not to collide when two SVGs share
  // a page; the layout signature gives that without threading the source through the renderer.
  const uid = hash(JSON.stringify([graph.direction, layout, theme]));
  const paletteIndex = subgraphPalette(graph);
  const defs = renderDefs(theme, uid);

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${layout.width}" height="${layout.height}" rx="20" fill="${xmlEscape(theme.background)}"/>`);
  if (theme.grid) parts.push(`<rect x="0" y="0" width="${layout.width}" height="${layout.height}" rx="20" fill="url(#${uid}-grid)"/>`);

  for (const box of layout.subgraphs) parts.push(renderSubgraph(box, theme, paletteIndex.get(box.id)));

  const edgeParts = [];
  for (const edge of layout.edges) edgeParts.push(renderEdge(edge, theme, uid));
  parts.push(`<g class="fc-edges">${edgeParts.join("")}</g>`);

  const nodeParts = [];
  for (const node of layout.nodes) {
    const spec = graph.nodes.get(node.id);
    nodeParts.push(renderNode(node, spec, theme, paletteIndex, uid));
  }
  parts.push(`<g class="fc-nodes">${nodeParts.join("")}</g>`);
  parts.push(`<g class="fc-labels">${layout.edges.map(edge => renderEdgeLabel(edge, theme)).join("")}</g>`);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}"`,
    ` viewBox="0 0 ${layout.width} ${layout.height}" font-family="${xmlEscape(theme.fontFamily)}"`,
    ` data-codex-proxy="flowchart" role="img" aria-labelledby="${uid}-title" style="max-width:100%;height:auto">`,
    `<title id="${uid}-title">${xmlEscape([...graph.nodes.values()].slice(0, 6).map(node => node.label).join(" → "))}</title>`,
    defs,
    parts.join(""),
    `</svg>`,
  ].join("");
}

function renderEmpty(theme) {
  const width = 240;
  const height = 72;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`,
    ` font-family="${xmlEscape(theme.fontFamily)}" data-codex-proxy="flowchart">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${theme.background}"/>`,
    `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="central"`,
    ` font-size="${theme.fontSize}" fill="${theme.edge.text}">empty flowchart</text>`,
    `</svg>`,
  ].join("");
}

function renderDefs(theme, uid) {
  return [
    `<defs>`,
    `<marker id="${uid}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"`,
    ` orient="auto-start-reverse"><path d="M2,1 L9,5 L2,9" fill="none" stroke="${theme.edge.stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>`,
    `<filter id="${uid}-shadow" x="-30%" y="-40%" width="160%" height="180%">`,
    `<feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#172b4d" flood-opacity="0.08"/></filter>`,
    `<pattern id="${uid}-grid" width="24" height="24" patternUnits="userSpaceOnUse">`,
    `<circle cx="2" cy="2" r="0.7" fill="${theme.grid}"/></pattern>`,
    `</defs>`,
  ].join("");
}

function subgraphPalette(graph) {
  const map = new Map();
  graph.subgraphs.forEach((subgraph, index) => map.set(subgraph.id, index));
  return map;
}

function nodeColors(node, theme, paletteIndex) {
  const palette = theme.palette ?? [];
  let base = theme.node;
  if (node?.subgraph && paletteIndex.has(node.subgraph) && palette.length > 0) {
    base = palette[paletteIndex.get(node.subgraph) % palette.length];
  }
  const style = node?.style ?? {};
  return {
    fill: style.fill ?? base.fill,
    stroke: style.stroke ?? base.stroke,
    text: style.color ?? theme.node.text,
    strokeWidth: parseLength(style["stroke-width"], theme.node.strokeWidth),
    dash: style["stroke-dasharray"] ?? "",
  };
}

function renderNode(node, spec, theme, paletteIndex, uid) {
  const colors = nodeColors(spec, theme, paletteIndex);
  const dash = colors.dash === "" ? "" : ` stroke-dasharray="${xmlEscape(colors.dash)}"`;
  const shape = (() => {
    switch (spec?.shape) {
      case "round":
        return `<rect x="${r(node.cx - node.w / 2)}" y="${r(node.cy - node.h / 2)}" width="${r(node.w)}" height="${r(node.h)}" rx="${r(node.h / 2)}" ry="${r(node.h / 2)}"/>`;
      case "stadium":
        return `<rect x="${r(node.cx - node.w / 2)}" y="${r(node.cy - node.h / 2)}" width="${r(node.w)}" height="${r(node.h)}" rx="${r(node.h / 2)}" ry="${r(node.h / 2)}"/>`;
      case "subroutine":
        return (
          `<rect x="${r(node.cx - node.w / 2)}" y="${r(node.cy - node.h / 2)}" width="${r(node.w)}" height="${r(node.h)}" rx="4" ry="4"/>` +
          `<line x1="${r(node.cx - node.w / 2 + 9)}" y1="${r(node.cy - node.h / 2)}" x2="${r(node.cx - node.w / 2 + 9)}" y2="${r(node.cy + node.h / 2)}"/>` +
          `<line x1="${r(node.cx + node.w / 2 - 9)}" y1="${r(node.cy - node.h / 2)}" x2="${r(node.cx + node.w / 2 - 9)}" y2="${r(node.cy + node.h / 2)}"/>`
        );
      case "cylinder":
        return cylinder(node);
      case "circle":
        return `<circle cx="${r(node.cx)}" cy="${r(node.cy)}" r="${r(node.w / 2)}"/>`;
      case "diamond":
        return `<polygon points="${diamondPoints(node)}"/>`;
      case "hexagon":
        return `<polygon points="${hexagonPoints(node)}"/>`;
      case "parallelogram":
        return `<polygon points="${parallelogramPoints(node)}"/>`;
      case "trapezoid":
        return `<polygon points="${trapezoidPoints(node)}"/>`;
      case "asymmetric":
        return `<polygon points="${asymmetricPoints(node)}"/>`;
      default:
        return `<rect x="${r(node.cx - node.w / 2)}" y="${r(node.cy - node.h / 2)}" width="${r(node.w)}" height="${r(node.h)}" rx="${theme.node.radius}" ry="${theme.node.radius}"/>`;
    }
  })();

  const label = textBlock(node.cx, node.cy, node.lines ?? String(spec?.label ?? node.id).split("\n"), {
    size: theme.fontSize,
    fill: colors.text,
    weight: 500,
  });

  return (
    `<g class="fc-node">` +
    `<g filter="url(#${uid}-shadow)" fill="${xmlEscape(colors.fill)}" stroke="${xmlEscape(colors.stroke)}" stroke-width="${colors.strokeWidth}" stroke-linejoin="round"${dash}>${shape}</g>` +
    `<g stroke="none">${label}</g>` +
    `</g>`
  );
}

function renderEdge(edge, theme, uid) {
  const thicker = edge.kind === "thick";
  const strokeWidth = thicker ? theme.edge.strokeWidth * 1.8 : theme.edge.strokeWidth;
  const dash = edge.kind === "dotted" ? ` stroke-dasharray="5 5"` : "";
  const marker = edge.arrow ? ` marker-end="url(#${uid}-arrow)"` : "";
  const path = `<path d="${edge.d}" fill="none" stroke="${theme.edge.stroke}" stroke-width="${r(strokeWidth)}"${dash}${marker} stroke-linecap="round"/>`;

  return path;
}

function renderEdgeLabel(edge, theme) {
  if (!String(edge.label ?? "").trim()) return "";
  const lines = edge.lines ?? [edge.label];
  const width = edge.labelWidth ?? measure(edge.label, theme.fontSize - 1) + 20;
  const height = edge.labelHeight ?? theme.fontSize + 10;
  return `<g class="fc-edge-label"><rect x="${r(edge.labelX - width / 2)}" y="${r(edge.labelY - height / 2)}" width="${r(width)}" height="${r(height)}" rx="8" fill="${xmlEscape(theme.edge.labelBackground)}" stroke="#e2e8f0" stroke-width="1"/>` +
    textBlock(edge.labelX, edge.labelY, lines, { size: theme.fontSize - 1, fill: theme.edge.text, weight: 500 }) + `</g>`;
}

function renderSubgraph(box, theme, paletteIndex) {
  const spec = theme.subgraph;
  const title = box.lines ?? String(box.title ?? "").split("\n");
  const accent = theme.palette?.[paletteIndex % theme.palette.length]?.stroke ?? spec.stroke;
  const caption = textBlock(box.x + 28, box.y + 22 + (title.length - 1) * spec.labelSize * 0.7, title, {
    size: spec.labelSize,
    fill: spec.text,
    weight: 700,
    anchor: "start",
  });
  return (
    `<g class="fc-subgraph">` +
    `<rect x="${r(box.x)}" y="${r(box.y)}" width="${r(box.w)}" height="${r(box.h)}" rx="${spec.radius}" ry="${spec.radius}" fill="${spec.fill}" stroke="${spec.stroke}" stroke-width="1.2"${spec.dashed === false ? "" : ' stroke-dasharray="0"'}/>` +
    `<rect x="${r(box.x + 16)}" y="${r(box.y + 16)}" width="3" height="12" rx="1.5" fill="${xmlEscape(accent)}"/>` +
    caption +
    `</g>`
  );
}

function textBlock(cx, cy, lines, { size, fill, weight = 400, anchor = "middle" }) {
  const lineHeight = size * 1.4;
  const start = cy - ((lines.length - 1) * lineHeight) / 2;
  return lines
    .map(
      (line, index) =>
        `<text x="${r(cx)}" y="${r(start + index * lineHeight)}" text-anchor="${anchor}" dominant-baseline="central" font-size="${size}" font-weight="${weight}" fill="${xmlEscape(fill)}">${xmlEscape(line)}</text>`,
    )
    .join("");
}

function cylinder(node) {
  const x0 = node.cx - node.w / 2;
  const x1 = node.cx + node.w / 2;
  const y0 = node.cy - node.h / 2;
  const y1 = node.cy + node.h / 2;
  const rx = node.w / 2;
  const ry = Math.min(11, node.h / 6);
  return (
    `<path d="M ${r(x0)} ${r(y0 + ry)} A ${r(rx)} ${r(ry)} 0 0 1 ${r(x1)} ${r(y0 + ry)} L ${r(x1)} ${r(y1 - ry)} A ${r(rx)} ${r(ry)} 0 0 1 ${r(x0)} ${r(y1 - ry)} Z"/>` +
    `<path d="M ${r(x0)} ${r(y0 + ry)} A ${r(rx)} ${r(ry)} 0 0 0 ${r(x1)} ${r(y0 + ry)}" fill="none"/>`
  );
}

function diamondPoints(node) {
  const { cx, cy, w, h } = node;
  return [
    `${r(cx)},${r(cy - h / 2)}`,
    `${r(cx + w / 2)},${r(cy)}`,
    `${r(cx)},${r(cy + h / 2)}`,
    `${r(cx - w / 2)},${r(cy)}`,
  ].join(" ");
}

function hexagonPoints(node) {
  const { cx, cy, w, h } = node;
  const inset = Math.min(w * 0.2, h * 0.55);
  return [
    `${r(cx - w / 2 + inset)},${r(cy - h / 2)}`,
    `${r(cx + w / 2 - inset)},${r(cy - h / 2)}`,
    `${r(cx + w / 2)},${r(cy)}`,
    `${r(cx + w / 2 - inset)},${r(cy + h / 2)}`,
    `${r(cx - w / 2 + inset)},${r(cy + h / 2)}`,
    `${r(cx - w / 2)},${r(cy)}`,
  ].join(" ");
}

function parallelogramPoints(node) {
  const { cx, cy, w, h } = node;
  const skew = Math.min(w * 0.18, 22);
  return [
    `${r(cx - w / 2 + skew)},${r(cy - h / 2)}`,
    `${r(cx + w / 2)},${r(cy - h / 2)}`,
    `${r(cx + w / 2 - skew)},${r(cy + h / 2)}`,
    `${r(cx - w / 2)},${r(cy + h / 2)}`,
  ].join(" ");
}

function trapezoidPoints(node) {
  const { cx, cy, w, h } = node;
  const skew = Math.min(w * 0.18, 24);
  return [
    `${r(cx - w / 2 + skew)},${r(cy - h / 2)}`,
    `${r(cx + w / 2 - skew)},${r(cy - h / 2)}`,
    `${r(cx + w / 2)},${r(cy + h / 2)}`,
    `${r(cx - w / 2)},${r(cy + h / 2)}`,
  ].join(" ");
}

function asymmetricPoints(node) {
  const { cx, cy, w, h } = node;
  const skew = Math.min(w * 0.18, 20);
  return [
    `${r(cx - w / 2)},${r(cy - h / 2)}`,
    `${r(cx + w / 2 - skew)},${r(cy - h / 2)}`,
    `${r(cx + w / 2)},${r(cy)}`,
    `${r(cx + w / 2 - skew)},${r(cy + h / 2)}`,
    `${r(cx - w / 2)},${r(cy + h / 2)}`,
  ].join(" ");
}

export function xmlEscape(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hash(text) {
  let value = 5381;
  const input = String(text);
  for (let i = 0; i < input.length; i++) value = ((value << 5) + value + input.charCodeAt(i)) | 0;
  return `fc${(value >>> 0).toString(36)}`;
}

function parseLength(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? "").replace(/px$/, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function r(value) {
  return Math.round(value * 100) / 100;
}
