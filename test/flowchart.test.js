import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../plugins/flowchart/index.js";
import { parseMermaid } from "../plugins/flowchart/mermaid.js";
import { layoutGraph } from "../plugins/flowchart/layout.js";
import { renderFlowchart, xmlEscape } from "../plugins/flowchart/svg.js";
import { defaultTheme } from "../plugins/flowchart/theme.js";

test("parseMermaid reads direction, shapes, labelled edges and subgraphs", () => {
  const graph = parseMermaid(`flowchart TD
    A([Start]) --> B{Choice?}
    B -->|yes| C[/Load/]
    B -- no --> D((Retry))
    subgraph loop[Loop]
      C --> D
    end
  `);

  assert.equal(graph.direction, "TD");
  assert.equal(graph.nodes.get("A").shape, "stadium");
  assert.equal(graph.nodes.get("B").shape, "diamond");
  assert.equal(graph.nodes.get("C").shape, "parallelogram");
  assert.equal(graph.nodes.get("D").shape, "circle");
  assert.equal(graph.nodes.get("C").subgraph, "loop");
  assert.equal(graph.nodes.get("B").label, "Choice?");

  const edges = graph.edges.map((edge) => `${edge.from}->${edge.to}:${edge.label || "-"}`);
  assert.deepEqual(edges, ["A->B:-", "B->C:yes", "B->D:no", "C->D:-"]);
});

test("parseMermaid reads edges written without spaces", () => {
  const graph = parseMermaid(`flowchart TD
    A-->B
    B-.->C
    C==>D
    D---E
  `);
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.from}-${edge.kind}${edge.arrow ? ">" : ""}-${edge.to}`),
    ["A-normal>-B", "B-dotted>-C", "C-thick>-D", "D-normal-E"],
  );
  assert.deepEqual([...graph.nodes.keys()], ["A", "B", "C", "D", "E"]);
});

test("parseMermaid keeps quoted labels, line breaks and style overrides", () => {
  const graph = parseMermaid(`flowchart LR
    classDef hot fill:#fdd,stroke:#c00
    X["a (b)<br/>c"] --> Y
    style Y fill:#dfd
    class X hot
  `);
  assert.equal(graph.nodes.get("X").label, "a (b)\nc");
  assert.equal(graph.nodes.get("Y").style.fill, "#dfd");
  assert.equal(graph.nodes.get("X").style.stroke, "#c00");
  assert.equal(graph.direction, "LR");
});

test("parseMermaid keeps the real statements and drops comments", () => {
  const graph = parseMermaid("not a diagram\n%% a comment\nA --> B");
  assert.ok(graph.nodes.has("A") && graph.nodes.has("B"));
  assert.equal(graph.edges.length, 1);
});

test("the plugin refuses to render prose that is not a diagram", () => {
  assert.equal(plugin.fences.mermaid("not a diagram\n%% a comment"), null);
});

test("renderFlowchart emits a self-describing SVG", () => {
  const graph = parseMermaid("flowchart TD\n  A[Start] --> B{Done?}");
  const svg = renderFlowchart(graph, layoutGraph(graph, defaultTheme), defaultTheme);

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /data-codex-proxy="flowchart"/);
  assert.match(svg, /Start/);
  // The source rides the thinking channel, not the SVG, so the rendered markup stays clean.
  assert.ok(!svg.includes("codex-proxy-source"), "the source must not be embedded in the SVG");
});

test("xmlEscape handles every character that would break a text node", () => {
  assert.equal(xmlEscape(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
});

test("the plugin renders a mermaid fence to an svg code block", () => {
  const rendered = plugin.fences.mermaid("flowchart TD\n  A[Start] --> B[End]");
  assert.match(rendered, /^```svg\n<svg [\s\S]*<\/svg>\n```$/);
  assert.ok(rendered.includes('data-codex-proxy="flowchart"'));
});

test("the plugin leaves mermaid it cannot read as a fence", () => {
  assert.equal(plugin.fences.mermaid("just some prose"), null);
});

test("the plugin restores its rendered svg instead of showing it to the model", () => {
  assert.equal(typeof plugin.restoreText, "function");
  const rendered = plugin.fences.mermaid("flowchart TD\n  A --> B");
  const restored = plugin.restoreText(`answer\n${rendered}`);
  assert.match(restored, /```mermaid/);
  assert.ok(!restored.includes("```svg"));
});

test("long multilingual labels wrap and remain inside the SVG canvas", () => {
  const graph = parseMermaid(`flowchart LR
    A[这是一段需要自动换行的中文流程节点说明文字而且应该完整显示] -->|A long explanation of the transition between these two steps| B[Finished]
  `);
  const layout = layoutGraph(graph, defaultTheme);
  assert.ok(layout.nodes[0].lines.length > 1);
  assert.ok(layout.edges[0].lines.length > 1);
  for (const edge of layout.edges) {
    assert.ok(edge.labelX - edge.labelWidth / 2 >= 0);
    assert.ok(edge.labelX + edge.labelWidth / 2 <= layout.width);
    assert.ok(edge.labelY - edge.labelHeight / 2 >= 0);
    assert.ok(edge.labelY + edge.labelHeight / 2 <= layout.height);
  }
  const svg = renderFlowchart(graph, layout, defaultTheme);
  assert.ok(svg.indexOf('class="fc-labels"') > svg.indexOf('class="fc-edges"'));
});

test("reverse flow directions attach arrows to the facing sides", () => {
  for (const direction of ["LR", "RL", "TD", "BT"]) {
    const graph = parseMermaid(`flowchart ${direction}\nA[First] --> B[Second]`);
    const layout = layoutGraph(graph, defaultTheme);
    const [from, to] = layout.nodes;
    const coords = layout.edges[0].d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const horizontal = direction === "LR" || direction === "RL";
    const sign = direction === "RL" || direction === "BT" ? -1 : 1;
    const start = horizontal ? coords[0] : coords[1];
    const end = horizontal ? coords.at(-2) : coords.at(-1);
    assert.ok(Math.abs(start - ((horizontal ? from.cx : from.cy) + sign * (horizontal ? from.w : from.h) / 2)) < 0.02);
    assert.ok(Math.abs(end - ((horizontal ? to.cx : to.cy) - sign * (horizontal ? to.w : to.h) / 2)) < 0.02);
  }
});

test("decision branches connect to the diamond outline", () => {
  const graph = parseMermaid("flowchart TD\nA{Ready?} --> B[Yes]\nA --> C[No]");
  const layout = layoutGraph(graph, defaultTheme);
  const decision = layout.nodes[0];
  for (const edge of layout.edges) {
    const [x, y] = edge.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    assert.ok(Math.abs(Math.abs(x - decision.cx) / (decision.w / 2) + Math.abs(y - decision.cy) / (decision.h / 2) - 1) < 0.001);
  }
});

test("restoreText puts the model's own mermaid back where the rendered svg stood", () => {
  const rendered = plugin.fences.mermaid("flowchart TD\n  A[Start] --> B[Done]");
  assert.match(rendered, /```svg/);
  const out = plugin.restoreText(`Here you go\n${rendered}`);
  assert.equal(out, "Here you go\n```mermaid\nflowchart TD\n  A[Start] --> B[Done]\n```");
  assert.ok(!out.includes("```svg"), "the generated svg must not survive a replay");
});

test("restoreText recovers the source from a carried fence after a restart", () => {
  const source = "flowchart LR\n  X --> Y";
  const stranger = '```svg\n<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>\n```';
  const out = plugin.restoreText(`See:\n${stranger}`, { fences: new Map([["mermaid", [source]]]) });
  assert.equal(out, `See:\n\`\`\`mermaid\n${source}\n\`\`\``);
});
