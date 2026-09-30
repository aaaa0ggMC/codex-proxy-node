// Layered layout for flowcharts. Nodes are assigned to layers by longest path, ordered inside a
// layer by a barycentre heuristic, then spread out and pulled toward their neighbours. That is the
// same shape of algorithm a graph library uses, kept small enough to read and dependency-free.

const PAD_X = 24;
const PAD_Y = 16;
const MIN_W = 88;
const MIN_H = 48;
const LAYER_GAP = 62;
const NODE_GAP = 34;

export function layoutGraph(graph, theme = {}) {
  const ids = [...graph.nodes.keys()];
  const base = {
    direction: graph.direction,
    nodes: [],
    edges: [],
    subgraphs: [],
    width: 0,
    height: 0,
  };
  if (ids.length === 0) return base;

  const sizes = new Map(ids.map((id) => [id, nodeSize(graph.nodes.get(id), theme)]));
  const adjacency = buildAdjacency(graph, ids);
  const { layers, layerOf } = layerGraph(graph, ids, adjacency);
  orderLayers(layers, adjacency, layerOf);

  const horizontal = graph.direction === "LR" || graph.direction === "RL";
  const labelGap = Math.max(0, ...graph.edges.filter(edge => edge.label).map(edge => {
    const lines = wrapText(edge.label, (theme.fontSize ?? 14) - 1, theme.maxTextWidth ?? 196);
    return horizontal
      ? Math.max(...lines.map(line => measure(line, (theme.fontSize ?? 14) - 1))) + 52
      : lines.length * ((theme.fontSize ?? 14) - 1) * 1.4 + 42;
  }));
  const centers = placeNodes(layers, sizes, adjacency, horizontal, { ...theme, layerGap: Math.max(theme.layerGap ?? LAYER_GAP, labelGap) });
  // BT and RL are the same picture, read the other way: flip the main axis at the end.
  if (graph.direction === "BT" || graph.direction === "RL") flip(layers, centers, horizontal);

  const nodes = new Map();
  for (const id of ids) {
    const size = sizes.get(id);
    const center = centers.get(id);
    nodes.set(id, { id, cx: center.x, cy: center.y, w: size.w, h: size.h, lines: size.lines, shape: graph.nodes.get(id).shape });
  }

  const edges = routeEdges(graph, nodes, layerOf, horizontal);
  const subgraphs = subgraphBoxes(graph, nodes, theme);

  for (const edge of edges) {
    edge.lines = wrapText(edge.label ?? "", (theme.fontSize ?? 14) - 1, theme.maxTextWidth ?? 196);
    edge.labelWidth = Math.max(...edge.lines.map(line => measure(line, (theme.fontSize ?? 14) - 1)), 0) + 20;
    edge.labelHeight = edge.lines.length * ((theme.fontSize ?? 14) - 1) * 1.4 + 10;
  }
  translate({ nodes, edges, subgraphs, horizontal, theme });

  const box = bounds(nodes, edges, subgraphs, theme);
  return {
    direction: graph.direction,
    nodes: [...nodes.values()],
    edges,
    subgraphs,
    width: box.width,
    height: box.height,
  };
}

function nodeSize(node, theme) {
  const fontSize = theme.fontSize ?? 14;
  const lines = wrapText(node.label, fontSize, theme.maxTextWidth ?? 196);
  const width = Math.max(...lines.map((line) => measure(line, fontSize)), 0);
  const textHeight = Math.max(lines.length, 1) * fontSize * 1.4;

  switch (node.shape) {
    case "circle": {
      const diameter = Math.max(width * 1.55, textHeight * 1.7 + 18, 48);
      return { w: diameter, h: diameter, lines };
    }
    case "diamond":
      return { w: (width + PAD_X) * 2, h: (textHeight + PAD_Y) * 2, lines };
    case "hexagon":
      return { w: width + PAD_X * 3, h: Math.max(MIN_H, textHeight + PAD_Y * 2), lines };
    default:
      return { w: Math.max(MIN_W, width + PAD_X * 2), h: Math.max(MIN_H, textHeight + PAD_Y * 2), lines };
  }
}

// Preserve explicit breaks; wrap words first, then split unusually long tokens / CJK.
export function wrapText(text, fontSize = 14, maxWidth = 196) {
  const limit = Math.max(fontSize * 4, maxWidth);
  return String(text ?? "").split("\n").flatMap(paragraph => {
    const lines = [];
    let line = "";
    for (const token of paragraph.match(/\s+|[a-zA-Z0-9_./:-]+|[^\s]/gu) ?? []) {
      if (line && measure(line + token, fontSize) > limit) {
        lines.push(line.trimEnd());
        line = "";
      }
      for (const char of token) {
        if (!line && /\s/.test(char)) continue;
        if (line && measure(line + char, fontSize) > limit) {
          lines.push(line.trimEnd());
          line = "";
        }
        line += char;
      }
    }
    return [...lines, line.trimEnd()];
  });
}

// measure approximates rendered text width: roughly 0.58em for latin, a full em for CJK.
export function measure(text, fontSize = 14) {
  let width = 0;
  for (const char of String(text ?? "")) {
    const code = char.codePointAt(0);
    if (isWide(code)) width += fontSize;
    else if (char === " ") width += fontSize * 0.3;
    else width += fontSize * 0.58;
  }
  return width;
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  );
}

function buildAdjacency(graph, ids) {
  const outgoing = new Map(ids.map((id) => [id, []]));
  const incoming = new Map(ids.map((id) => [id, []]));
  for (const edge of graph.edges) {
    if (!outgoing.has(edge.from) || !incoming.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  }
  return { outgoing, incoming };
}

// layerGraph finds the longest path through the graph. Cycles would make that undefined, so a DFS
// marks the edges that close a cycle and layering skips them, which keeps the picture readable.
function layerGraph(graph, ids, adjacency) {
  const state = new Map(ids.map((id) => [id, 0]));
  const finish = [];
  const back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const next of adjacency.outgoing.get(id)) {
      if (state.get(next) === 1) {
        back.add(`${id}\u0000${next}`);
        continue;
      }
      if (state.get(next) === 0) visit(next);
    }
    state.set(id, 2);
    finish.push(id);
  };
  for (const id of ids) if (state.get(id) === 0) visit(id);

  const layerOf = new Map(ids.map((id) => [id, 0]));
  for (const id of [...finish].reverse()) {
    for (const next of adjacency.outgoing.get(id)) {
      if (back.has(`${id}\u0000${next}`)) continue;
      layerOf.set(next, Math.max(layerOf.get(next), layerOf.get(id) + 1));
    }
  }

  const count = Math.max(...layerOf.values(), 0) + 1;
  const layers = Array.from({ length: count }, () => []);
  for (const id of ids) layers[layerOf.get(id)].push(id);
  return { layers, layerOf };
}

function orderLayers(layers, adjacency, layerOf) {
  const index = new Map();
  const reindex = () => {
    for (const layer of layers) layer.forEach((id, i) => index.set(id, i));
  };
  reindex();

  const barycentre = (id, neighbours) => {
    const positions = neighbours.map((n) => index.get(n)).filter((p) => p != null);
    if (positions.length === 0) return index.get(id) ?? 0;
    return positions.reduce((a, b) => a + b, 0) / positions.length;
  };
  const sortLayer = (layer, neighboursOf) => {
    const keys = new Map(layer.map((id) => [id, { b: barycentre(id, neighboursOf(id)), i: index.get(id) }]));
    layer.sort((a, b) => {
      const ka = keys.get(a);
      const kb = keys.get(b);
      return ka.b === kb.b ? ka.i - kb.i : ka.b - kb.b;
    });
  };

  for (let pass = 0; pass < 4; pass++) {
    for (let l = 1; l < layers.length; l++) {
      sortLayer(layers[l], (id) => adjacency.incoming.get(id));
      reindex();
    }
    for (let l = layers.length - 2; l >= 0; l--) {
      sortLayer(layers[l], (id) => adjacency.outgoing.get(id));
      reindex();
    }
  }
}

function placeNodes(layers, sizes, adjacency, horizontal, theme) {
  const layerGap = Math.max(theme.layerGap ?? LAYER_GAP, (theme.subgraph?.padding ?? 26) * 2 + 40);
  const nodeGap = Math.max(theme.nodeGap ?? NODE_GAP, (theme.subgraph?.padding ?? 26) * 2 + 16);
  const centers = new Map();
  const thickness = layers.map((layer) =>
    layer.reduce((max, id) => Math.max(max, horizontal ? sizes.get(id).w : sizes.get(id).h), 0),
  );
  const totalCross = layers.map((layer) =>
    layer.reduce((sum, id) => sum + (horizontal ? sizes.get(id).h : sizes.get(id).w), 0) +
    Math.max(0, layer.length - 1) * nodeGap,
  );
  const widest = Math.max(...totalCross, 0);

  let main = 0;
  for (let l = 0; l < layers.length; l++) {
    const layer = layers[l];
    const cross = totalCross[l];
    let cursor = -widest / 2 + (widest - cross) / 2;
    const center = main + thickness[l] / 2;
    for (const id of layer) {
      const size = sizes.get(id);
      const span = horizontal ? size.h : size.w;
      const at = cursor + span / 2;
      centers.set(id, horizontal ? { x: center, y: at } : { x: at, y: center });
      cursor += span + nodeGap;
    }
    main += thickness[l] + layerGap;
  }

  align(layers, centers, sizes, adjacency, horizontal, nodeGap);
  return centers;
}

// align nudges each node toward the average position of its neighbours, then pushes overlapping
// nodes apart while keeping their order. Two passes are enough to straighten most chains.
function align(layers, centers, sizes, adjacency, horizontal, nodeGap) {
  const crossOf = (id) => (horizontal ? centers.get(id).y : centers.get(id).x);
  const sizeOf = (id) => (horizontal ? sizes.get(id).h : sizes.get(id).w);

  for (let pass = 0; pass < 2; pass++) {
    for (let l = 0; l < layers.length; l++) {
      const layer = layers[l];
      const desired = layer.map((id) => {
        const neighbours = [...adjacency.incoming.get(id), ...adjacency.outgoing.get(id)];
        const positions = neighbours.map(crossOf).filter((v) => v != null);
        return positions.length === 0
          ? crossOf(id)
          : positions.reduce((a, b) => a + b, 0) / positions.length;
      });

      const before = layer.reduce((sum, id) => sum + crossOf(id), 0) / layer.length;
      resolve(desired, layer.map(sizeOf), nodeGap);
      const after = desired.reduce((a, b) => a + b, 0) / desired.length;
      const shift = before - after;

      layer.forEach((id, i) => {
        const value = desired[i] + shift;
        if (horizontal) centers.get(id).y = value;
        else centers.get(id).x = value;
      });
    }
  }
}

function resolve(centers, sizes, gap) {
  for (let i = 1; i < centers.length; i++) {
    const min = centers[i - 1] + (sizes[i - 1] + sizes[i]) / 2 + gap;
    if (centers[i] < min) centers[i] = min;
  }
  for (let i = centers.length - 2; i >= 0; i--) {
    const max = centers[i + 1] - (sizes[i] + sizes[i + 1]) / 2 - gap;
    if (centers[i] > max) centers[i] = max;
  }
}

function flip(layers, centers, horizontal) {
  const all = layers.flat();
  if (all.length === 0) return;
  const values = all.map((id) => (horizontal ? centers.get(id).x : centers.get(id).y));
  const min = Math.min(...values);
  const max = Math.max(...values);
  for (const id of all) {
    if (horizontal) centers.get(id).x = max + min - centers.get(id).x;
    else centers.get(id).y = max + min - centers.get(id).y;
  }
}

function routeEdges(graph, nodes, layerOf, horizontal) {
  const reverse = graph.direction === "RL" || graph.direction === "BT";
  if (reverse) {
    const mirrored = new Map([...nodes].map(([id, node]) => [id, { ...node, cx: horizontal ? -node.cx : node.cx, cy: horizontal ? node.cy : -node.cy }]));
    return routeEdges({ ...graph, direction: horizontal ? "LR" : "TD" }, mirrored, layerOf, horizontal).map(edge => {
      let index = 0;
      return { ...edge, d: edge.d.replace(/-?\d+(?:\.\d+)?/g, value => String(Number(value) * ((index++ % 2 === (horizontal ? 0 : 1)) ? -1 : 1))), labelX: horizontal ? -edge.labelX : edge.labelX, labelY: horizontal ? edge.labelY : -edge.labelY };
    });
  }
  const outIndex = new Map();
  const inIndex = new Map();
  for (const edge of graph.edges) {
    const key = edge.from;
    if (!outIndex.has(key)) outIndex.set(key, []);
    outIndex.get(key).push(edge);
    const inKey = edge.to;
    if (!inIndex.has(inKey)) inIndex.set(inKey, []);
    inIndex.get(inKey).push(edge);
  }

  return graph.edges.map((edge) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from == null || to == null) return { ...edge, d: "", label: edge.label, labelX: 0, labelY: 0 };
    if (edge.from === edge.to) return selfLoop(edge, from);

    const forward = horizontal ? to.cx > from.cx : to.cy > from.cy;
    if (forward) {
      const outs = outIndex.get(edge.from) ?? [];
      const ins = inIndex.get(edge.to) ?? [];
      const outAt = (outs.indexOf(edge) - (outs.length - 1) / 2) * portStep(from, horizontal, outs.length);
      const inAt = (ins.indexOf(edge) - (ins.length - 1) / 2) * portStep(to, horizontal, ins.length);
      return orthogonal(edge, from, to, outAt, inAt, horizontal);
    }
    return bowed(edge, from, to, horizontal);
  });
}

function portStep(node, horizontal, count) {
  const span = horizontal ? node.h : node.w;
  return Math.min(22, span / (count + 1));
}

// Attach ports to the visible outline instead of the enclosing rectangle.
function boundaryExtent(node, offset, horizontal) {
  const main = (horizontal ? node.w : node.h) / 2;
  const cross = (horizontal ? node.h : node.w) / 2;
  const ratio = Math.min(1, Math.abs(offset) / cross);
  if (node.shape === "diamond") return main * (1 - ratio);
  if (node.shape === "circle") return main * Math.sqrt(1 - ratio * ratio);
  if (horizontal && ["round", "stadium"].includes(node.shape)) {
    return main - cross + Math.sqrt(cross * cross - offset * offset);
  }
  return main;
}

function orthogonal(edge, from, to, outAt, inAt, horizontal) {
  if (horizontal) {
    const x1 = from.cx + boundaryExtent(from, outAt, true);
    const x2 = to.cx - boundaryExtent(to, inAt, true);
    const y1 = from.cy + outAt;
    const y2 = to.cy + inAt;
    const mid = (x1 + x2) / 2;
    return {
      ...edge,
      d: `M ${r(x1)} ${r(y1)} C ${r(mid)} ${r(y1)} ${r(mid)} ${r(y2)} ${r(x2)} ${r(y2)}`,
      labelX: (x1 + 3 * mid + 3 * mid + x2) / 8,
      labelY: (y1 + 3 * y1 + 3 * y2 + y2) / 8,
    };
  }
  const y1 = from.cy + boundaryExtent(from, outAt, false);
  const y2 = to.cy - boundaryExtent(to, inAt, false);
  const x1 = from.cx + outAt;
  const x2 = to.cx + inAt;
  const mid = (y1 + y2) / 2;
  return {
    ...edge,
    d: `M ${r(x1)} ${r(y1)} C ${r(x1)} ${r(mid)} ${r(x2)} ${r(mid)} ${r(x2)} ${r(y2)}`,
    labelX: (x1 + 3 * x1 + 3 * x2 + x2) / 8,
    labelY: (y1 + 3 * mid + 3 * mid + y2) / 8,
  };
}

// A back edge or a sideways edge leaves from the side and bows around, so it never cuts through a
// node that sits between the two ends.
function bowed(edge, from, to, horizontal) {
  const bow = Math.max(56, Math.abs(horizontal ? to.cy - from.cy : to.cx - from.cx) / 2);
  if (horizontal) {
    const x1 = from.cx;
    const y1 = from.cy + from.h / 2;
    const x2 = to.cx;
    const y2 = to.cy + to.h / 2;
    return {
      ...edge,
      d: `M ${r(x1)} ${r(y1)} C ${r(x1)} ${r(y1 + bow)} ${r(x2)} ${r(y2 + bow)} ${r(x2)} ${r(y2)}`,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2 + bow * 0.75,
    };
  }
  const x1 = from.cx + from.w / 2;
  const y1 = from.cy;
  const x2 = to.cx + to.w / 2;
  const y2 = to.cy;
  return {
    ...edge,
    d: `M ${r(x1)} ${r(y1)} C ${r(x1 + bow)} ${r(y1)} ${r(x2 + bow)} ${r(y2)} ${r(x2)} ${r(y2)}`,
    labelX: (x1 + x2) / 2 + bow * 0.75,
    labelY: (y1 + y2) / 2,
  };
}

function selfLoop(edge, node) {
  const x = node.cx + node.w / 2;
  const y = node.cy - node.h / 4;
  const loop = Math.max(26, node.w * 0.4);
  return {
    ...edge,
    d: `M ${r(x)} ${r(y)} C ${r(x + loop)} ${r(y - loop)} ${r(x + loop)} ${r(y + loop)} ${r(x)} ${r(y + 14)}`,
    labelX: x + loop * 0.8,
    labelY: y,
  };
}

function subgraphBoxes(graph, nodes, theme) {
  const pad = theme.subgraph?.padding ?? 26;
  const boxes = [];
  for (const subgraph of graph.subgraphs) {
    const members = subgraph.members.map((id) => nodes.get(id)).filter(Boolean);
    if (members.length === 0) continue;
    const titleLines = wrapText(subgraph.title, theme.subgraph?.labelSize ?? 12.5, theme.maxTextWidth ?? 196);
    const titleHeight = titleLines.length * (theme.subgraph?.labelSize ?? 12.5) * 1.4;
    const minX = Math.min(...members.map((n) => n.cx - n.w / 2)) - pad;
    const maxX = Math.max(...members.map((n) => n.cx + n.w / 2)) + pad;
    const minY = Math.min(...members.map((n) => n.cy - n.h / 2)) - pad - titleHeight - 16;
    const maxY = Math.max(...members.map((n) => n.cy + n.h / 2)) + pad;
    boxes.push({
      id: subgraph.id,
      title: subgraph.title,
      x: minX,
      y: minY,
      lines: titleLines,
      w: Math.max(maxX - minX, ...titleLines.map(line => measure(line, theme.subgraph?.labelSize ?? 12.5) + 40)),
      h: maxY - minY,
    });
  }
  return boxes;
}

// translate moves everything into positive coordinates with a margin, so the SVG viewBox is simple.
function translate({ nodes, edges, subgraphs, theme }) {
  const xs = [];
  const ys = [];
  for (const node of nodes.values()) {
    xs.push(node.cx - node.w / 2, node.cx + node.w / 2);
    ys.push(node.cy - node.h / 2, node.cy + node.h / 2);
  }
  for (const box of subgraphs) {
    xs.push(box.x, box.x + box.w);
    ys.push(box.y, box.y + box.h);
  }
  for (const edge of edges) {
    if (typeof edge.d !== "string") continue;
    for (const point of samplePath(edge.d)) {
      xs.push(point.x);
      ys.push(point.y);
    }
    if (edge.label) {
      xs.push(edge.labelX - edge.labelWidth / 2, edge.labelX + edge.labelWidth / 2);
      ys.push(edge.labelY - edge.labelHeight / 2, edge.labelY + edge.labelHeight / 2);
    }
  }
  if (xs.length === 0) return;
  const dx = -(Math.min(...xs) - (theme.padding ?? 36));
  const dy = -(Math.min(...ys) - (theme.padding ?? 36));
  for (const node of nodes.values()) {
    node.cx += dx;
    node.cy += dy;
  }
  for (const edge of edges) {
    edge.d = shiftPath(edge.d, dx, dy);
    edge.labelX += dx;
    edge.labelY += dy;
  }
  for (const box of subgraphs) {
    box.x += dx;
    box.y += dy;
  }
}

// samplePath reads the numbers out of "M x y C ..." and returns a coarse set of points, enough to
// pad the viewBox so a curve that bows outside the nodes is not clipped.
function samplePath(d) {
  const numbers = (String(d).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const points = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push({ x: numbers[i], y: numbers[i + 1] });
  return points;
}

function shiftPath(d, dx, dy) {
  let index = 0;
  return String(d).replace(/-?\d+(?:\.\d+)?/g, (value) => {
    const shifted = Number(value) + (index++ % 2 === 0 ? dx : dy);
    return String(Math.round(shifted * 100) / 100);
  });
}

function bounds(nodes, edges, subgraphs, theme) {
  const xs = [];
  const ys = [];
  for (const node of nodes.values()) {
    xs.push(node.cx - node.w / 2, node.cx + node.w / 2);
    ys.push(node.cy - node.h / 2, node.cy + node.h / 2);
  }
  for (const box of subgraphs) {
    xs.push(box.x, box.x + box.w);
    ys.push(box.y, box.y + box.h);
  }
  for (const edge of edges) {
    for (const point of samplePath(edge.d)) {
      xs.push(point.x);
      ys.push(point.y);
    }
  }
  for (const edge of edges) {
    if (!edge.label) continue;
    xs.push(edge.labelX + edge.labelWidth / 2);
    ys.push(edge.labelY + edge.labelHeight / 2);
  }
  const width = xs.length === 0 ? 0 : Math.max(...xs) + (theme.padding ?? 36);
  const height = ys.length === 0 ? 0 : Math.max(...ys) + (theme.padding ?? 36);
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

function r(value) {
  return Math.round(value * 100) / 100;
}
