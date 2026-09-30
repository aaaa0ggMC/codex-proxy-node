// A small mermaid reader, scoped to the flowchart family. It understands the shapes and edges a
// model actually reaches for when it sketches a flow, and ignores the rest rather than guessing:
// an unknown statement is dropped, never rendered wrongly.

export function parseMermaid(source) {
  const graph = {
    direction: "TD",
    nodes: new Map(),
    edges: [],
    subgraphs: [],
    classDefs: new Map(),
  };

  let current = null; // the subgraph being written
  const idOf = (text) => {
    const trimmed = String(text ?? "").trim();
    if (trimmed === "") return "";
    return trimmed.replace(/\s+/g, "-").toLowerCase();
  };

  for (const statement of splitStatements(source)) {
    const line = statement.trim();
    if (line === "") continue;

    const header = /^(?:flowchart|graph)\s+(TB|TD|BT|RL|LR)\b/i.exec(line);
    if (header != null) {
      graph.direction = header[1].toUpperCase();
      continue;
    }
    if (/^subgraph\b/i.test(line)) {
      current = openSubgraph(graph, line.slice("subgraph".length).trim(), idOf);
      continue;
    }
    if (/^end$/i.test(line)) {
      current = null;
      continue;
    }
    if (/^(?:direction|linkStyle|click|accTitle|accDescr)\b/i.test(line)) continue;

    const classDef = /^classDef\s+([A-Za-z0-9_-]+)\s+(.+)$/i.exec(line);
    if (classDef != null) {
      graph.classDefs.set(classDef[1], parseStyle(classDef[2]));
      continue;
    }
    const classAssign = /^class\s+([A-Za-z0-9_,\s-]+?)\s+([A-Za-z0-9_-]+)\s*$/i.exec(line);
    if (classAssign != null) {
      const cls = classAssign[2];
      for (const id of classAssign[1].split(",").map((part) => part.trim()).filter(Boolean)) {
        const node = ensureNode(graph, id);
        if (node != null) node.classes.push(cls);
      }
      continue;
    }
    const style = /^style\s+([A-Za-z0-9_-]+)\s+(.+)$/i.exec(line);
    if (style != null) {
      const node = ensureNode(graph, style[1]);
      if (node != null) node.style = { ...node.style, ...parseStyle(style[2]) };
      continue;
    }

    parseStatement(graph, line, current, idOf);
  }

  resolveStyles(graph);
  return finalize(graph);
}

// splitStatements cuts on newlines and semicolons, but not inside a quoted label, so a label that
// contains either character survives.
function splitStatements(source) {
  const statements = [];
  for (const rawLine of String(source ?? "").split("\n")) {
    const line = stripComment(rawLine);
    let buffer = "";
    let quote = false;
    for (const char of line) {
      if (char === '"') quote = !quote;
      if (char === ";" && !quote) {
        statements.push(buffer);
        buffer = "";
        continue;
      }
      buffer += char;
    }
    statements.push(buffer);
  }
  return statements;
}

function stripComment(line) {
  const index = indexOfUnquoted(line, "%%");
  return index === -1 ? line : line.slice(0, index);
}

function indexOfUnquoted(text, token) {
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quote = !quote;
    if (!quote && text.startsWith(token, i)) return i;
  }
  return -1;
}

// Shapes, longest opener first so "([" is not mistaken for "(".
const SHAPES = [
  { open: "[[", close: "]]", shape: "subroutine" },
  { open: "[(", close: ")]", shape: "cylinder" },
  { open: "([", close: "])", shape: "stadium" },
  { open: "((", close: "))", shape: "circle" },
  { open: "{{", close: "}}", shape: "hexagon" },
  { open: "[/", close: "/]", shape: "parallelogram" },
  { open: "[\\", close: "\\]", shape: "parallelogram" },
  { open: "[/", close: "\\]", shape: "trapezoid" },
  { open: "[\\", close: "/]", shape: "trapezoid" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "diamond" },
  { open: ">", close: "]", shape: "asymmetric" },
];

// readId reads a node id. A hyphen is allowed inside an id (my-node) but not when it opens an
// edge (-->, -.->, ---), which is the one case where the regex would otherwise eat the connector.
function readId(text, start) {
  const first = text[start];
  if (first == null || !/[A-Za-z0-9_\u4e00-\u9fff]/.test(first)) return "";
  let id = first;
  let i = start + 1;
  while (i < text.length) {
    const char = text[i];
    if (/[A-Za-z0-9_\u4e00-\u9fff]/.test(char)) {
      id += char;
      i++;
      continue;
    }
    if (char === "-" && text[i + 1] !== "-" && text[i + 1] !== ">" && text[i + 1] !== ".") {
      id += char;
      i++;
      continue;
    }
    break;
  }
  return id;
}

function parseStatement(graph, text, current, idOf) {
  let i = 0;
  const first = parseGroup(graph, text, i, current);
  if (first.nodes.length === 0) return;
  let left = first.nodes;
  i = first.next;

  for (;;) {
    i = skipSpace(text, i);
    if (i >= text.length) break;
    const edge = matchEdge(text, i);
    if (edge == null) break;
    i = skipSpace(text, edge.next);
    const right = parseGroup(graph, text, i, current);
    if (right.nodes.length === 0) break;
    for (const from of left) {
      for (const to of right.nodes) {
        if (from.id === to.id && edge.kind === "normal" && from.label === to.label) {
          // Self loops are meaningful; keep them, but only once.
        }
        graph.edges.push({ from: from.id, to: to.id, label: edge.label, kind: edge.kind, arrow: edge.arrow });
      }
    }
    left = right.nodes;
    i = right.next;
  }
}

function parseGroup(graph, text, start, current) {
  const nodes = [];
  let i = skipSpace(text, start);
  const spec = parseNodeSpec(graph, text, i, current);
  if (spec == null) return { nodes, next: start };
  nodes.push(spec.node);
  i = spec.next;
  for (;;) {
    const j = skipSpace(text, i);
    if (text[j] !== "&") break;
    const next = parseNodeSpec(graph, text, skipSpace(text, j + 1), current);
    if (next == null) break;
    nodes.push(next.node);
    i = next.next;
  }
  return { nodes, next: i };
}

function parseNodeSpec(graph, text, start, current) {
  const id = readId(text, start);
  if (id === "") return null;
  let i = start + id.length;

  let label = id;
  let shape = "rect";
  let declared = false;
  const rest = text.slice(i);
  for (const candidate of SHAPES) {
    if (!rest.startsWith(candidate.open)) continue;
    const end = findClose(text, i + candidate.open.length, candidate.close);
    if (end === -1) continue;
    label = unquote(text.slice(i + candidate.open.length, end));
    shape = candidate.shape;
    declared = true;
    i = end + candidate.close.length;
    break;
  }

  const node = ensureNode(graph, id, current);
  if (node == null) return null;
  // A node that was only referenced (no brackets) keeps its id as a label; a shape declaration
  // always wins and marks the node as deliberate, which is how prose is told apart from a diagram.
  if (declared) {
    node.label = splitLabel(label).join("\n");
    node.shape = shape;
    node.declared = true;
  }
  return { node, next: i };
}

function ensureNode(graph, rawId, subgraph = null) {
  const id = String(rawId ?? "").trim();
  if (id === "") return null;
  let node = graph.nodes.get(id);
  if (node == null) {
    node = {
      id,
      label: id,
      shape: "rect",
      classes: [],
      style: {},
      subgraph: subgraph == null ? "" : subgraph.id,
      declared: false,
    };
    graph.nodes.set(id, node);
  } else if (subgraph != null && node.subgraph === "") {
    node.subgraph = subgraph.id;
  }
  return node;
}

function openSubgraph(graph, header, idOf) {
  let id = idOf(header);
  let title = header;
  const labelled = /^([A-Za-z0-9_-]+)\s*\[(.*)\]$/.exec(header);
  if (labelled != null) {
    id = labelled[1];
    title = unquote(labelled[2]);
  } else if (header !== "") {
    id = idOf(header);
    title = unquote(header);
  }
  if (id === "") id = `subgraph-${graph.subgraphs.length + 1}`;
  const subgraph = { id, title: splitLabel(title).join("\n"), members: [] };
  graph.subgraphs.push(subgraph);
  return subgraph;
}

// findClose scans for the closing token, skipping over quoted text so a label like A["x]y"] works.
function findClose(text, start, close) {
  let quote = false;
  for (let i = start; i <= text.length - close.length; i++) {
    const char = text[i];
    if (char === '"' && text[i - 1] !== "\\") quote = !quote;
    if (!quote && text.startsWith(close, i)) return i;
  }
  return -1;
}

function matchEdge(text, start) {
  // "A -- label --> B" and its thick/dotted cousins: a label sits between two connector runs.
  const between = matchLabelBetween(text, start);
  if (between != null) return between;

  // Dotted first: the alternation is ordered, and "-+" would otherwise eat the first dash of "-.-".
  const plain = /^(-\.-+|-+|=+)(>?)\s*(?:\|([^|]*)\|)?/.exec(text.slice(start));
  if (plain == null) return null;
  const body = plain[1];
  const arrow = plain[2] === ">";
  const label = plain[3] == null ? "" : unquote(plain[3].trim());
  return { kind: kindOf(body), arrow, label, next: start + plain[0].length };
}

function matchLabelBetween(text, start) {
  const rest = text.slice(start);
  const dash = /^(-+)\s+("([^"]*)"|[^-\s][^-]*?)\s+(-+)(>?)/.exec(rest);
  const thick = /^(=+)\s+("([^"]*)"|[^=\s][^=]*?)\s+(=+)(>?)/.exec(rest);
  const dotted = /^(-\.-+)\s+("([^"]*)"|[^-.\s][^-.]*?)\s+(-\.-+)(>?)/.exec(rest);
  const pick = [dotted, dash, thick]
    .filter((m) => m != null)
    .sort((a, b) => a[0].length - b[0].length)[0];
  if (pick == null) return null;
  const label = pick[3] != null ? pick[3] : unquote(pick[2]);
  return {
    kind: kindOf(pick[1]),
    arrow: (pick[5] ?? pick[4]) === ">",
    label,
    next: start + pick[0].length,
  };
}

function kindOf(body) {
  if (body.startsWith("=")) return "thick";
  if (body.startsWith("-.")) return "dotted";
  return "normal";
}

function skipSpace(text, i) {
  let j = i;
  while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
  return j;
}

function splitLabel(label) {
  return String(label ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .split("\n")
    .map((line) => line.trim());
}

function unquote(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

function parseStyle(text) {
  const out = {};
  for (const chunk of String(text ?? "").split(",")) {
    const index = chunk.indexOf(":");
    if (index === -1) continue;
    const key = chunk.slice(0, index).trim().toLowerCase();
    const value = chunk.slice(index + 1).trim();
    if (key !== "" && value !== "") out[key] = value;
  }
  return out;
}

function resolveStyles(graph) {
  for (const node of graph.nodes.values()) {
    for (const cls of node.classes) {
      const def = graph.classDefs.get(cls);
      if (def != null) node.style = { ...node.style, ...def };
    }
  }
}

function finalize(graph) {
  for (const subgraph of graph.subgraphs) {
    subgraph.members = [...graph.nodes.values()]
      .filter((node) => node.subgraph === subgraph.id)
      .map((node) => node.id);
  }
  // Drop subgraphs that ended up empty rather than drawing an empty box.
  graph.subgraphs = graph.subgraphs.filter((subgraph) => subgraph.members.length > 0);
  return graph;
}
