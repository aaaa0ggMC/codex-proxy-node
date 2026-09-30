import { readFileSync } from "node:fs";
import path from "node:path";
import { parseMermaid } from "./mermaid.js";
import { layoutGraph } from "./layout.js";
import { renderFlowchart } from "./svg.js";
import { defaultTheme } from "./theme.js";

// Diagrams the model draws stay useful for the user and cheap for the model.
//
// Outbound, a ```mermaid fence in the answer is replaced by a rendered ```svg block. The proxy also
// writes the source onto the thinking channel as a carried <plugin-fence> block (src/sdk.js), and
// restoreDiagram puts the model's own fence back on the way in — the model never sees the markup.

const INSTRUCTIONS = [
  "When a process, hierarchy or relationship is clearer as a picture, write it as a ```mermaid",
  "fenced block and keep the surrounding prose short. Use `flowchart TD` or `flowchart LR`;",
  "shapes: `id[step]`, `id(round)`, `id{decision}`, `id((start/end))`, `id[/data/]`;",
  "edges: `A --> B`, `A -->|label| B`, `A -.-> B`, `A ==> B`; group related steps with",
  "`subgraph name ... end`. The proxy renders the diagram to an SVG for the user, so do not",
  "also describe it at length.",
].join(" ");

const theme = loadTheme();

// rendered fences, keyed by the exact bytes we sent, mapped back to the mermaid the model wrote.
// The SVG carries no source of its own (that would bloat it and leak into the user's view), so the
// pair is remembered here; after a restart the carried <plugin-fence> block supplies it instead.
const rendered = new Map();
const MAX_RENDERED = 32;

// A fuller reference than the always-on instructions: it is attached only when the user asks for it
// with @plugin:flowchart, so the prompt does not carry the whole cheat sheet every turn.
const LORE = [
  "mermaid flowchart reference:",
  "- Header: `flowchart TD` (top-down) or `flowchart LR` (left-right); TB/BT/RL also work.",
  "- Nodes: `id[rect]` `id(round)` `id([stadium])` `id[[subroutine]]` `id[(cylinder)]` `id((circle))`",
  "  `id{decision}` `id{{hexagon}}` `id[/data/]` `id[\\data\\]` `id>asymmetric]`.",
  "- Edges: `A --> B`, `A --- B`, `A -.-> B` (dotted), `A ==> B` (thick).",
  "- Edge labels: `A -->|label| B` or `A -- label --> B`. Chains and fan-out work: `A --> B --> C`, `A --> B & C`.",
  "- Group with `subgraph name[Title] ... end`. Style with `classDef hot fill:#fdd,stroke:#c00` +",
  "  `class A hot`, or `style A fill:#dfd`.",
  "- Label text may be quoted and may use `<br/>` for line breaks; `%%` starts a comment.",
  "Keep diagrams small enough to read at a glance and rely on the rendered image, not prose.",
].join("\n");

// User-facing documentation for the console's plugin page. Plain Markdown; the console renders it
// with the small renderer in src/markdown.js.
const DOCS = [
  "# flowchart",
  "",
  "When a picture says it better, the model writes a mermaid block and the client shows a rendered",
  "SVG in its place.",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[model writes a fence] --> B[proxy renders an SVG]",
  "  B --> C[client shows the picture]",
  "  C --> D[client replays the history]",
  "  D --> E[proxy lifts the carried source]",
  "  E --> A",
  "```",
  "",
  "## How it works",
  "",
  "1. The plugin's `instructions` tell the model it may answer with a mermaid block.",
  "2. Outbound, the proxy holds that block back, renders it, and streams the SVG in its place.",
  "   The source rides the thinking channel as a carried block, so the client stores it.",
  "3. Inbound, `restoreText` puts the mermaid fence back where the SVG stood, so the model sees",
  "   its own text again and never the generated markup. The carried block is only its source of",
  "   truth (it also survives a proxy restart) and is not shown to the model.",
  "",
  "The round trip covers both `/v1/chat/completions` and `/v1/responses`, streaming or not.",
  "",
  "## What it can draw",
  "",
  "- `flowchart TD` / `graph LR`, also `TB`, `BT` and `RL`.",
  "- Shapes: `id[rect]`, `id(round)`, `id([stadium]`, `id[[subroutine]]`, `id[(cylinder)]`,",
  "  `id((circle))`, `id{decision}`, `id{{hexagon}}`, `id[/data/]`, `id[\data\]`, `id>asymmetric]`.",
  "- Edges: `-->`, `---`, `-.->`, `-.-`, `==>`, `===`, labelled as `A -->|label| B` or",
  "  `A -- label --> B`, chained as `A --> B --> C`, fanned out as `A --> B & C`.",
  "- `subgraph name ... end`, `classDef`, `class` and `style`.",
  "- Quoted labels, `<br/>` line breaks, `%%` comments.",
  "",
  "Anything it cannot read — a lone word that wandered into a fence, a shape it does not know — is",
  "left exactly as the model wrote it, so an unsupported diagram shows up as code rather than as a",
  "broken picture.",
  "",
  "## The theme",
  "",
  "`theme.js` holds the colours, fonts, spacing and shadow. To restyle without touching code, drop",
  "a `theme.json` beside this file:",
  "",
  "```json",
  '{ "fontSize": 15, "node": { "fill": "#f3f0ff", "stroke": "#7c5cff", "text": "#241a4d" } }',
  "```",
  "",
  "It is read once at start, like everything a plugin contributes to the prompt, so restart the",
  "proxy after changing it.",
  "",
  "## Switching it off",
  "",
  "Disable the plugin from the admin page (`/admin/plugins`), or per conversation with",
  "`<disable_module>flowchart</disable_module>` in the first user message. With the plugin off, a",
  "mermaid fence reaches the client as plain code.",
  "",
].join("\n");

export default {
  name: "flowchart",
  namespace: false,
  docs: DOCS,
  instructions: INSTRUCTIONS,
  lore: LORE,
  fences: { mermaid: renderMermaid },
  restoreText: restoreDiagram,
};

function renderMermaid(source) {
  let graph;
  try {
    graph = parseMermaid(source);
  } catch {
    return null;
  }
  // A single bare word is prose that wandered into a fence, not a diagram. Only render something
  // with a real edge or an explicitly shaped node, and otherwise leave the fence untouched.
  const deliberate = graph.edges.length > 0 || [...graph.nodes.values()].some((node) => node.declared);
  if (graph.nodes.size === 0 || !deliberate) return null;
  const layout = layoutGraph(graph, theme);
  const svg = renderFlowchart(graph, layout, theme);
  // Delivered as an ```svg fence, not a data-URI image: plenty of clients (RikkaHub among them)
  // refuse a `data:` source inside a markdown image and render an empty box, while the same bytes
  // in an svg fence draw a picture where the client supports it and readable code where it does not.
  return rememberRendered("```svg\n" + svg + "\n```", source);
}

function rememberRendered(fence, source) {
  if (rendered.size >= MAX_RENDERED) rendered.delete(rendered.keys().next().value);
  rendered.set(fence, source);
  return fence;
}

function mermaidFence(source) {
  return "```mermaid\n" + source + "\n```";
}

// restoreDiagram is the inbound half of the render. A replayed answer shows the generated svg; this
// puts the model's own mermaid back where it stood, so the model never sees that its answer was
// rewritten. The source is the exact string remembered at render time, or — after a restart — the
// <plugin-fence> the client carried, paired with the rendered fences in order.
function restoreDiagram(text, { fences } = {}) {
  if (typeof text !== "string" || !text.includes("```svg")) return text;
  let out = text;
  for (const [fence, source] of rendered) {
    if (out.includes(fence)) out = out.split(fence).join(mermaidFence(source));
  }
  const sources = [...(fences?.get?.("mermaid") ?? [])];
  if (sources.length > 0) {
    out = out.replace(/```svg\n[\s\S]*?\n```/g, (match) => {
      const source = sources.shift();
      return source == null ? match : mermaidFence(source);
    });
  }
  return out;
}

// A theme.json next to this file overrides the template without editing the renderer. Read once at
// start, like everything else a plugin puts into the prompt, so a diagram stays reproducible.
function loadTheme() {
  try {
    const raw = JSON.parse(readFileSync(path.join(import.meta.dirname, "theme.json"), "utf8"));
    return {
      ...defaultTheme,
      ...raw,
      node: { ...defaultTheme.node, ...(raw.node ?? {}) },
      edge: { ...defaultTheme.edge, ...(raw.edge ?? {}) },
      subgraph: { ...defaultTheme.subgraph, ...(raw.subgraph ?? {}) },
    };
  } catch {
    return defaultTheme;
  }
}
