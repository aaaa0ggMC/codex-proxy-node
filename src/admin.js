import { readFile, writeFile } from "node:fs/promises";

// A tiny admin surface for the plugin toggles. MCPHub already reverse-proxies /apps/<id>/* to the
// service, so serving this page here is all the dashboard integration that is needed.

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
body{font:15px system-ui;margin:0;padding:24px;background:#111;color:#eee}
h1{font-size:18px;margin:0 0 4px}p{color:#999;margin:0 0 20px;font-size:13px}
.row{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #333;border-radius:10px;margin-bottom:10px}
.row.on{border-color:#2f6f4f}.name{font-weight:600;min-width:120px}
.tools{color:#888;font-size:12px;flex:1}
button{background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer}
button:hover{background:#333}.on button{border-color:#2f6f4f}
</style></head><body>
<h1>Plugins</h1><p>Toggling applies to the next request. Tool sets are part of the prompt, so changing one invalidates the cache for that conversation once.</p>
<div id="list">loading…</div>
<script>
async function draw(){
  const {plugins} = await (await fetch('plugins.json')).json();
  const list = document.getElementById('list');
  if(!plugins.length){list.textContent='no plugins loaded';return}
  list.innerHTML = plugins.map(p=>\`<div class="row \${p.enabled?'on':''}">
    <span class="name">\${p.name}</span>
    <span class="tools">\${p.tools.join(', ')||'no tools'}</span>
    <button data-name="\${p.name}" data-enabled="\${!p.enabled}">\${p.enabled?'disable':'enable'}</button>
  </div>\`).join('');
  for(const b of list.querySelectorAll('button')){
    b.onclick = async () => {
      b.disabled = true;
      await fetch(encodeURIComponent(b.dataset.name), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:b.dataset.enabled==='true'})});
      await draw();
    };
  }
}
draw();
</script></body></html>`;
}
