import { readFile, writeFile } from "node:fs/promises";
import { renderMarkdown } from "./markdown.js";

// A tiny admin surface for the plugin toggles. MCPHub already reverse-proxies /apps/<id>/* to the
// service, so serving this page here is all the dashboard integration that is needed.
//
// Routes:
//   GET  /admin/plugins          the console (browse schema + docs, toggle a plugin)
//   GET  /admin/plugins.json     enabled/disabled state, for a supervisor
//   GET  /admin/catalog.json     plugins + tools + rendered docs, for the console
//   POST /admin/plugins/<name>   {enabled: bool}

export async function loadDisabledPlugins(file) {
  try {
    const state = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(state?.disabled) ? state.disabled : [];
  } catch {
    return [];
  }
}

export async function saveDisabledPlugins(file, registry) {
  const disabled = registry.pluginNames().filter((name) => !registry.isEnabled(name));
  await writeFile(file, JSON.stringify({ disabled }, null, 2) + "\n");
}

function snapshot(registry) {
  return registry.pluginNames().map((name) => ({
    name,
    enabled: registry.isEnabled(name),
    tools: registry.toolsOf(name),
  }));
}

// catalogFor is the browse view: the same catalog, with every document rendered once here so the
// page itself is a plain innerHTML assignment.
function catalogFor(registry) {
  return registry.catalog().map((plugin) => ({
    name: plugin.name,
    enabled: plugin.enabled,
    docsHTML: renderMarkdown(plugin.docs),
    tools: plugin.tools.map((tool) => ({
      name: tool.name,
      schema: tool.schema,
      docsHTML: renderMarkdown(tool.docs),
    })),
  }));
}

export async function handleAdmin(req, res, url, { registry, stateFile, log }) {
  if (registry == null) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("no plugins are loaded\n");
    return true;
  }

  if (url.pathname === "/admin/plugins.json" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ plugins: snapshot(registry) }));
    return true;
  }

  if (url.pathname === "/admin/catalog.json" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ plugins: catalogFor(registry) }));
    return true;
  }

  const toggle = url.pathname.match(/^\/admin\/plugins\/([a-zA-Z0-9_-]+)$/);
  if (toggle && req.method === "POST") {
    const name = toggle[1];
    let body = "";
    for await (const chunk of req) body += chunk;
    let enabled = true;
    try {
      const parsed = JSON.parse(body || "{}");
      if (typeof parsed?.enabled === "boolean") enabled = parsed.enabled;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "body must be JSON" }));
      return true;
    }
    try {
      registry.setEnabled(name, enabled);
    } catch (err) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
      return true;
    }
    await saveDisabledPlugins(stateFile, registry);
    log?.info("plugin toggled", { plugin: name, enabled, takes_effect: "next request" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ plugins: snapshot(registry) }));
    return true;
  }

  if (url.pathname === "/admin/plugins" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page());
    return true;
  }
  return false;
}

function page() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>codex-proxy plugins</title>
<style>
body{font:15px system-ui;margin:0;padding:24px;background:#111;color:#eee;line-height:1.55}
a,a:link,a:visited{color:#6ea8fe;text-decoration:none}
a:hover,a:active{color:#9cc4ff;text-decoration:underline}
a:focus-visible{outline:2px solid #6ea8fe;outline-offset:2px;border-radius:4px}
.doc a{text-decoration:underline;text-underline-offset:2px}
h1{font-size:20px;margin:0 0 6px}
h2{font-size:18px;margin:0 0 6px}
h3{font-size:13px;margin:22px 0 8px;color:#9aa4b2;text-transform:uppercase;letter-spacing:.04em}
p.muted,.muted{color:#7c8697;font-size:13px;margin:0 0 14px}
#error{color:#ff8080;font-size:13px;min-height:18px;margin:8px 0}
.row{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #333;border-radius:10px;margin-bottom:10px}
.row.on{border-color:#2f6f4f}.name{font-weight:600;min-width:110px}
.tools{color:#888;font-size:12px;flex:1;min-width:0}
.tools summary{cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tools .list{margin-top:6px;color:#aaa;overflow-wrap:anywhere;line-height:1.8}
button{background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;white-space:nowrap}
button:hover{background:#333}.on button{border-color:#2f6f4f}button[disabled]{opacity:.5;cursor:default}
.back{display:inline-block;margin-bottom:14px;font-size:13px;text-decoration:none}
.badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid #3a4658;color:#9fb0c8;vertical-align:middle}
.badge.on{border-color:#2f6f4f;color:#7fd0a0}
pre.schema{background:#0c1018;border:1px solid #2a3444;border-radius:10px;padding:12px;overflow:auto;font-size:12.5px;color:#cfe3ff}
.tool-list{list-style:none;padding:0;margin:0}
.tool-list li{padding:10px 12px;border:1px solid #333;border-radius:10px;margin-bottom:8px}
.doc{background:#14171c;border:1px solid #2a2f38;border-radius:10px;padding:6px 18px 12px;font-size:14px}
.doc h1,.doc h2{font-size:17px;margin:18px 0 8px}
.doc h3{font-size:14px;margin:16px 0 6px;color:#cbd5e1;text-transform:none;letter-spacing:0}
.doc code{background:#0c1018;border:1px solid #2a3444;border-radius:5px;padding:1px 5px;font-size:12.5px}
.doc pre{background:#0c1018;border:1px solid #2a3444;border-radius:8px;padding:10px;overflow:auto}
.doc pre code{border:0;background:none;padding:0}
.doc blockquote{border-left:3px solid #3a4658;margin:10px 0;padding:2px 12px;color:#a9b4c4}
.doc ul,.doc ol{padding-left:22px}.doc li{margin:4px 0}
.doc hr{border:0;border-top:1px solid #2a2f38;margin:16px 0}
</style></head><body>
<h1>Plugins</h1>
<p class="muted">Toggling applies to the next request. Tool sets are part of the prompt, so changing one invalidates the cache for that conversation once. Click a plugin or a tool for its schema and documentation.</p>
<p id="error"></p>
<div id="view">loading…</div>
<script>
var esc = function (value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};
var catalog = [];

function findTool(name) {
  for (var i = 0; i < catalog.length; i++) {
    var tools = catalog[i].tools || [];
    for (var j = 0; j < tools.length; j++) if (tools[j].name === name) return { plugin: catalog[i], tool: tools[j] };
  }
  return null;
}
function encode(value) { return encodeURIComponent(value); }
function docHTML(html) {
  return html || '<p class="muted">No documentation yet. Add a <code>docs</code> string to this plugin or tool.</p>';
}

function renderList() {
  if (catalog.length === 0) { document.getElementById('view').textContent = 'no plugins loaded'; return; }
  var rows = catalog.map(function (p) {
    return '<div class="row ' + (p.enabled ? 'on' : '') + '">' +
      '<a class="name" href="#plugin/' + encode(p.name) + '">' + esc(p.name) + '</a>' +
      toolCell(p) +
      '<button data-name="' + esc(p.name) + '" data-enabled="' + (!p.enabled) + '">' + (p.enabled ? 'disable' : 'enable') + '</button>' +
      '</div>';
  });
  document.getElementById('view').innerHTML = rows.join('');
  var buttons = document.querySelectorAll('#view button');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].onclick = toggleFrom(buttons[i]);
  }
}

function toolCell(plugin) {
  var tools = plugin.tools || [];
  if (tools.length === 0) return '<span class="tools">no tools</span>';
  var label = tools.length === 1 ? tools[0].name : tools.length + ' tools';
  var links = tools.map(function (t) {
    return '<a href="#tool/' + encode(t.name) + '">' + esc(t.name) + '</a>';
  }).join('<br>');
  return '<details class="tools"><summary>' + esc(label) + '</summary><div class="list">' + links + '</div></details>';
}

function renderPlugin(name) {
  var plugin = null;
  for (var i = 0; i < catalog.length; i++) if (catalog[i].name === name) plugin = catalog[i];
  if (!plugin) return renderMissing(name);
  var tools = plugin.tools || [];
  var body = tools.length === 0
    ? '<p class="muted">This plugin ships no tools.</p>'
    : '<ul class="tool-list">' + tools.map(function (t) {
        return '<li><a href="#tool/' + encode(t.name) + '">' + esc(t.name) + '</a>' +
          '<div class="muted">' + esc(t.schema.description) + '</div></li>';
      }).join('') + '</ul>';
  document.getElementById('view').innerHTML =
    '<a class="back" href="#">← all plugins</a>' +
    '<h2>' + esc(plugin.name) + ' <span class="badge ' + (plugin.enabled ? 'on' : '') + '">' + (plugin.enabled ? 'enabled' : 'disabled') + '</span></h2>' +
    '<div class="doc">' + docHTML(plugin.docsHTML) + '</div>' +
    '<h3>Tools (' + tools.length + ')</h3>' + body;
}

function renderTool(name) {
  var found = findTool(name);
  if (!found) return renderMissing(name);
  document.getElementById('view').innerHTML =
    '<a class="back" href="#plugin/' + encode(found.plugin.name) + '">← ' + esc(found.plugin.name) + '</a>' +
    '<h2>' + esc(found.tool.name) + '</h2>' +
    '<p class="muted">from plugin <a href="#plugin/' + encode(found.plugin.name) + '">' + esc(found.plugin.name) + '</a></p>' +
    '<h3>The full schema the model sees</h3>' +
    '<pre class="schema">' + esc(JSON.stringify(found.tool.schema, null, 2)) + '</pre>' +
    '<h3>Documentation for people</h3>' +
    '<div class="doc">' + docHTML(found.tool.docsHTML) + '</div>';
}

function renderMissing(name) {
  document.getElementById('view').innerHTML = '<a class="back" href="#">← all plugins</a>' +
    '<p class="muted">Nothing named ' + esc(name) + '.</p>';
}

function render() {
  document.getElementById('error').textContent = '';
  var hash = location.hash.replace(/^#/, '');
  if (hash.charAt(0) === '/') hash = hash.slice(1);
  hash = decodeURIComponent(hash);
  if (hash.indexOf('tool/') === 0) return renderTool(hash.slice(5));
  if (hash.indexOf('plugin/') === 0) return renderPlugin(hash.slice(7));
  renderList();
}

function toggleFrom(button) {
  return function () { toggle(button, button.dataset.name, button.dataset.enabled === 'true'); };
}

function toggle(button, name, enabled) {
  var error = document.getElementById('error');
  error.textContent = '';
  button.disabled = true;
  fetch('plugins/' + encodeURIComponent(name), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled }),
  }).then(function (response) {
    if (!response.ok) return response.text().then(function (detail) { throw new Error(response.status + ' ' + detail.slice(0, 200)); });
    return load();
  }).catch(function (err) {
    error.textContent = 'Could not toggle ' + name + ': ' + err.message;
    button.disabled = false;
  });
}

function load() {
  return fetch('catalog.json').then(function (response) {
    if (!response.ok) throw new Error(response.status);
    return response.json();
  }).then(function (data) {
    catalog = data.plugins;
    render();
  }).catch(function (err) {
    document.getElementById('error').textContent = 'Could not load plugins: ' + err.message;
  });
}

addEventListener('hashchange', render);
load();
</script></body></html>`;
}
