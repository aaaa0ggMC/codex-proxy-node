// The look of a rendered flowchart. This object is the template: edit it (or drop a
// plugins/flowchart/theme.json next to this file) to change colours and spacing without touching
// the renderer. Everything here is plain data, so it is trivial to swap wholesale.

export const defaultTheme = {
  fontFamily:
    '"Inter","Segoe UI",system-ui,-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
  fontSize: 14,
  background: "#f8fafc",
  grid: "#e2e8f0",
  padding: 36,
  shadow: "0 3px 8px rgba(23,43,77,0.08)",
  maxTextWidth: 196,
  layerGap: 84,
  nodeGap: 52,

  node: {
    fill: "#ffffff",
    stroke: "#bdcce0",
    text: "#16233d",
    strokeWidth: 1.4,
    radius: 12,
  },
  // Subgraphs cycle through these, so a diagram with a few groups reads as a few regions.
  palette: [
    { fill: "#eef2ff", stroke: "#a5b4fc" },
    { fill: "#ecfdf5", stroke: "#86cdb3" },
    { fill: "#fff7ed", stroke: "#e9bc85" },
    { fill: "#f5f3ff", stroke: "#c4b5fd" },
    { fill: "#fff1f2", stroke: "#f0a9b5" },
    { fill: "#ecfeff", stroke: "#8dced8" },
  ],
  edge: {
    stroke: "#94a3b8",
    text: "#4b5c7a",
    strokeWidth: 1.4,
    labelBackground: "#ffffff",
  },
  subgraph: {
    fill: "#f1f5f9",
    stroke: "#dce4ef",
    text: "#3d4f74",
    labelSize: 12.5,
    padding: 26,
    radius: 18,
  },
};
