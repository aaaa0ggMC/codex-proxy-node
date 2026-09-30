# codex-proxy (Node)

A small local OpenAI-compatible proxy backed by your existing Codex CLI ChatGPT login.

```text
OpenAI-compatible client -> http://127.0.0.1:6769/v1 -> ChatGPT Codex backend
```

`providers` may be an object keyed by name or an array where each entry carries `name`; both forms
behave the same. Entries that share a name form one namespace and are tried in order, so two keys
for the same service can back a single prefix — a request falls over to the next entry only if
nothing has been streamed yet. `codex` needs no key (it uses the ChatGPT login), but a `codex_home`
can point at another account.

This is the Node.js port of [aaaa0ggMC/codex-proxy](https://github.com/aaaa0ggMC/codex-proxy)
(itself a fork of [Max-Leopold/codex-proxy](https://github.com/Max-Leopold/codex-proxy)).
It keeps the same routes, flags and behaviour, but is a single dependency-free ESM codebase, which
makes it easy to read, extend and host next to other Node services such as MCPHub.

Like the Go version, this is a compatibility adapter, not a transparent OpenAI proxy. The Codex
backend requires streaming upstream requests and rejects some common OpenAI parameters, so the
proxy normalises requests before forwarding them.

## Requirements

- Node.js 20 or newer (uses the built-in `fetch`)
- Codex CLI authenticated with ChatGPT:

```bash
codex login
```

## Run

```bash
npm start
# or, with the same flags as the Go binary:
node src/index.js --port 6769
```

By default the server binds to `127.0.0.1` with no proxy API key, and prints:

```text
listening on http://127.0.0.1:6769
```

### Options

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--host` | – | `127.0.0.1` | Interface to bind. A non-loopback host requires an API key. |
| `--port` | – | `6769` | Port to listen on. |
| `--codex-home` | `CODEX_HOME` | `~/.codex` | Where `auth.json` lives. |
| `--api-key` | `CODEX_PROXY_API_KEY` | empty | When set, requests need `Authorization: Bearer <key>`. |
| `--web-search` | `CODEX_PROXY_WEB_SEARCH` | off | Enable the web search tool for every request. |
| – | `CODEX_PROXY_USAGE_TTL_SECONDS` | `15` | How long a fetched usage report may be reused. `0` always refreshes. |
| `--provider` | `CODEX_PROXY_PROVIDER` | `codex` | `codex` (ChatGPT login) or `openai` (any OpenAI-compatible endpoint). |
| `--upstream` | `CODEX_PROXY_UPSTREAM` | – | Base URL for the `openai` provider, e.g. `https://api.deepseek.com/v1`. |
| `--upstream-key` | `CODEX_PROXY_UPSTREAM_KEY` | – | Bearer token for the `openai` provider. |
| `--upstream-model` | `CODEX_PROXY_UPSTREAM_MODEL` | – | Force a model id instead of passing the client's through. |
| `--reasoning-effort` | `CODEX_PROXY_REASONING_EFFORT` | – | Reasoning effort sent to the `openai` provider (`low`, `medium`, `high`). |
| `--config` | `CODEX_PROXY_CONFIG` | `config.json` if present | Several providers in one file; see Multi-provider config. |
| `--image-max-edge` | `CODEX_PROXY_IMAGE_MAX_EDGE` | `1100` | Longest edge, in pixels, of an image handed to the model (256-4096). Bigger sees more detail and costs proportionally more tokens and bandwidth, since image bytes are re-sent every turn. |
| `--max-turns` | – | `256` | Upper bound on agent loop turns per request; a runaway guard, not a working limit. |
| `--discard-images` | – | `0` | Diagnostics only: keep images from the last N tool results. Non-zero breaks the prompt prefix on purpose. |
| – | `CODEX_PROXY_USAGE_TTL_SECONDS` | `15` | How long a fetched usage report may be reused. `0` always refreshes. |

To listen on a non-loopback interface you must set a proxy API key. Prefer the environment variable
on shared systems, because `--api-key` shows up in shell history and process lists:

```bash
CODEX_PROXY_API_KEY='replace-with-a-long-random-key' node src/index.js --host 0.0.0.0 --port 6769
```

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness probe. Never touches the upstream. Advertises the plugin console (below) when one is served. |
| `GET` | `/admin/plugins` | Plugin toggle console, for switching a plugin off without a restart. Only served when no proxy API key is set. |
| `GET` | `/admin/plugins.json` | The same state as JSON, for a supervisor. |
| `GET` | `/v1/models` | Model catalogue from the Codex backend. |
| `GET` | `/v1/usage` | Codex quota windows, with a cache that never delays a chat request. |
| `POST` | `/v1/responses` | Responses API. `/v1/responses` stays a pass-through. |
| `POST` | `/v1/chat/completions` | Chat Completions API, translated to the Responses API. |

Every response carries the last known quota in headers (`X-Codex-Usage-Remaining`,
`X-Codex-Usage-5h`, `X-Codex-Usage-Weekly`) once a usage report has been fetched. Reading those
headers never triggers an upstream call.

## Web search is a software feature

The Codex backend has no separate "search model". The proxy injects the `web_search` tool at the
software layer instead, and you drive it with ordinary request parameters:

```bash
# Standard OpenAI parameter
curl http://127.0.0.1:6769/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","web_search_options":{},"messages":[{"role":"user","content":"What happened in the news today?"}]}'

# A search tool, exactly like the Responses API
curl http://127.0.0.1:6769/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","tools":[{"type":"web_search"}],"messages":[{"role":"user","content":"What happened in the news today?"}]}'
```

Or force it for every request with `--web-search` / `CODEX_PROXY_WEB_SEARCH=1`.

### About the `-search` model names

Clients such as Rikkahub store a model id per conversation. If an id they saved disappears from
`/v1/models`, their history shows a blank model. To avoid that, the catalogue still lists
`<model>-search` and `<model>-search-preview` (plus the `gpt-4o-search-preview` alias).

Those names are **pure aliases**: they resolve to the same upstream model and do **not** enable web
search by themselves. Search is decided by the software layer, as described above. That keeps saved
histories resolving while a request's behaviour depends on its parameters, not on a naming
convention.

## Multimodal input

`chat/completions` messages may carry images. The chat `image_url` part (a `data:` URL or a public
URL) is translated to the Responses `input_image` part, so the Codex backend actually sees the
picture:

```bash
curl http://127.0.0.1:6769/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":[
        {"type":"text","text":"What is in this image?"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgo=","detail":"high"}}
      ]}]}'
```

Chat audio parts (`input_audio` with `data`/`format`) are translated to `input_audio` / `audio_url`
in the same way. The Codex backend has no file-attachment content type, so a `file` part is
rejected with `HTTP 400` and an explicit message rather than being silently dropped.

Tool results are rich too. A `tool` message whose `content` is an array is forwarded as the
`function_call_output` body the backend expects, so a tool can return images alongside text:

```json
{
  "role": "tool",
  "tool_call_id": "call_1",
  "content": [
    { "type": "text", "text": "Rendered 1 slide." },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,...", "detail": "high" } }
  ]
}
```

That is the hook a rich-content plugin (for example a deck renderer) needs to hand slides back to
the model. A text-only tool result stays a plain string.

The `/v1/responses` route stays a pass-through, so it forwards whatever content parts the caller
sends.

## Plugin console

Plugins reload only on restart, on purpose: swapping tools mid-conversation would invalidate the
cached prompt prefix. What does not need a restart is whether a plugin is *enabled*, so the proxy
serves a small console at `/admin/plugins` with a toggle per plugin. It writes the choice to
`plugins-state.json`, and the next request picks it up.

The console is served without a key, so it is only exposed when no proxy API key is configured —
a key-protected deployment does not get an unauthenticated control plane. In that case `/healthz`
stays a plain liveness answer; otherwise it advertises where the console lives:

```json
{ "ok": true, "ui": "/admin/plugins", "uiLabel": "Plugins" }
```

MCPHub reads that payload and puts a clickable panel entry on the service card, so the toggles are
one click away under `/apps/codex-proxy/admin/plugins`. Any supervisor that can read the health
body can do the same.

## Usage endpoint

```bash
curl http://127.0.0.1:6769/v1/usage                  # full JSON report
curl 'http://127.0.0.1:6769/v1/usage?format=text'    # "5h 88% · 7d 6%"
curl 'http://127.0.0.1:6769/v1/usage?format=number'  # tightest window, e.g. 6
curl 'http://127.0.0.1:6769/v1/usage?format=number&window=five_hour'
curl 'http://127.0.0.1:6769/v1/usage?refresh=1'      # bypass the cache
```

If a refresh fails but an older report exists, the last known numbers are served with
`"stale": true` instead of an error, so a dashboard keeps rendering.

## MCPHub

The proxy is a plain HTTP service, so MCPHub can supervise it like any other long-running process.
Add an entry to `servers.json` (no secrets needed here; the proxy reads the Codex login itself):

```json
{
  "id": "codex-proxy",
  "name": "Codex Proxy",
  "icon": "CX",
  "description": "OpenAI-compatible endpoint backed by the Codex CLI login",
  "command": "node",
  "args": ["src/index.js", "--port", "6769"],
  "cwd": "/path/to/codex-proxy-node",
  "kind": "service",
  "enabled": true,
  "autoStart": true,
  "port": 6769,
  "host": "127.0.0.1",
  "healthPath": "/healthz",
  "usagePath": "/v1/usage",
  "restart": "on-failure",
  "proxy": true
}
```

`healthPath` drives the up/down indicator and `usagePath` feeds the quota widget in the MCPHub
console.

## Client configuration

Most OpenAI-compatible clients can use:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:6769/v1
export OPENAI_API_KEY=dummy
```

The proxy ignores the incoming API key unless a proxy API key is configured; then `OPENAI_API_KEY`
must match the proxy API key.

## Development

```bash
npm test        # node --test
```

Layout, so a new feature has an obvious home:

| File | Responsibility |
| --- | --- |
| `src/index.js` | CLI entry: flags, wiring, `http.Server` setup. |
| `src/config.js` | Flag and environment parsing. |
| `src/auth.js` | Reads `~/.codex/auth.json` and refreshes the ChatGPT access token. |
| `src/codex.js` | The three upstream calls: models, streaming responses, usage. |
| `src/compat.js` | Chat Completions → Responses translation, including attachments. |
| `src/transforms.js` | Answer transforms: plugin-rendered fenced blocks, and restoring them on replay. |
| `src/schema.js` | OpenAI-compatible response shapes and builders. |
| `src/usage.js` | Quota normalisation, caching and one-line formatting. |
| `src/server.js` | Routes, middlewares, SSE streaming. |
| `src/sse.js` | Server-sent event reading and writing. |
| `src/log.js` | Small slog-style text logger. |
| `src/util.js` | Shared value helpers. |

Tests live in `test/*.test.js`; `test-support/helpers.js` holds the shared test scaffolding
(deliberately outside `test/`, which Node's test runner treats as test files).

## Differences from the Go version

- Same routes, flags, environment variables and response shapes.
- `-search` / `-search-preview` model ids are kept in `/v1/models` and resolve to their base model,
  but no longer force the web search tool on. Search is controlled entirely by
  `web_search_options`, `tools`, `tool_choice` or `--web-search`.
- No dependencies: only the Node standard library.
- **Providers**: `--provider codex` (default, ChatGPT Codex login) or `--provider openai` plus
  `--upstream` for any OpenAI-compatible endpoint (DeepSeek, StepFun, a local server). The
  `openai` provider bridges the canonical Responses format down to Chat Completions and back.
- **Plugins**: drop a folder into `plugins/` and its tools are offered to the model. The proxy runs
  them itself, including tools that return images. A plugin can also transform the answer and
  contribute context: the bundled [`flowchart`](plugins/flowchart/README.md) plugin renders a
  model's mermaid into an SVG and carries the source on the thinking channel, and the
  core activates a whole loaded module when a user says `@plugin:<name>`: tools, instructions,
  transforms and model-facing reference, even when globally off by default. Console docs are for
  people and are never injected; no separate `lore` field or mentions helper is required. See [plugins/README.md](plugins/README.md).

## Plugin context across turns

The core automatically archives local tool results, attachment descriptors, plugin contributions
and carried notes. Plugins normally just return their result; the model does not need to call a
checkpoint tool. A short `<proxy-context>` reference travels **only in thinking**
(`reasoning_content` for Chat Completions, a reasoning item for Responses). The answer body is
unchanged. Streaming and non-streaming requests both support this.

For Rikkahub, keep and replay the thinking field. Each new reply renews the latest reference, whose
snapshot includes earlier retained results, so older messages can be removed while the latest
reference remains. If the client removes **all** references, the proxy cannot identify the
conversation; it never guesses by a file name, user name or similar-looking chat text.

Small results are replayed as historical tool evidence. Results over 8,000 characters get an
explicit 2,000-character excerpt in the working prompt; the original text and images remain
available through the core's `proxy_context_read` tool. Text retrieval uses character offsets and
returns at most 12,000 characters per call; images/audio are retrieved individually. Reading the
archive never re-executes a plugin action. Saved notes are labelled separately from source results.

The CLI stores this local data in `.proxy-context/` (ignored by Git), surviving proxy restarts.
Use `--context-dir /path/to/cache` to relocate it, or `--context-dir=''` for memory only. The store
is bounded to 256 MiB and 4,096 blobs; snapshots retain up to 128 distinct results and replay up to
32,000 characters of small results, plus their catalog. Oversized/dropped results and missing
references are reported to the model; unavailable evidence must be read from its source again.
This repairs context loss, but is not a guarantee that a model can never hallucinate.

Existing conversations gain automatic retention after their next tool read; results lost before
this change cannot be recovered from a reference that was never written. Context references grant
access to their retained data, so treat exported thinking and the cache directory as conversation
data. The built-in server authenticates requests with its existing API key.

Plugins retain advanced `contribute`, carried-block and restore hooks. A plugin or individual tool
can set `context: "manual"` to opt its tool results out of automatic archival and excerpting. See
[the plugin contract](plugins/README.md).

## The cache rule

Prompt construction is deterministic for the same client history and retained evidence. Providers
cache by prompt prefix, so a random id, a
timestamp, or a tool set that varies per request silently destroys the hit rate for the whole
conversation.

That is why tool declarations are sorted, tool call ids are derived from content (`stableId` in
`src/util.js`), per-request context is appended at the tail rather than injected into
`instructions`, and plugins reload only on restart. Context references are stripped before the
provider sees them; historical results are inserted before the newest user message. New evidence
or cache eviction can change that restored suffix, so cross-request cache hits are not guaranteed.

The agent loop's own turns are appended at the tail, so the shared prefix — the whole conversation
history — still hits the cache; only the tokens after the last user turn are recomputed.

## Multi-provider config

For more than one upstream, describe them in `config.json` (see `config.example.json`) and the
proxy becomes a small aggregation platform: `/v1/models` lists every enabled provider's models, and
each request is routed by model id.

```json
{
  "default_provider": "codex",
  "providers": {
    "codex":    { "type": "codex", "enabled": true },
    "deepseek": { "type": "openai", "base_url": "https://api.deepseek.com/v1", "api_key_env": "DEEPSEEK_API_KEY" },
    "stepfun":  { "type": "openai", "base_url": "https://api.stepfun.ai/step_plan/v1", "api_key_env": "STEPFUN_API_KEY", "model": "step-3.7-flash" },
    "local":    { "type": "openai-responses", "base_url": "http://127.0.0.1:8080/v1", "models": ["my-model"] }
  }
}
```

Provider types are `codex` (ChatGPT Codex login), `openai` (Chat Completions, bridged) and
`openai-responses` (an endpoint that already speaks the Responses API). `enabled: false` parks one
without deleting it, and a provider that fails to list models is skipped with a warning rather than
blanking the catalogue.

`name` is the namespace, and it decides how the models are addressed:

- a named provider advertises `provider/model` (and the bare id too, when no other namespace claims
  it) — so a client with `gpt-5.6-luna` saved in its history keeps resolving;
- a provider with **no name** is not namespaced at all, so its models are asked for as `gpt-5.5`
  rather than `codex/gpt-5.5`. That is the usual choice when there is only one upstream that cares
  about bare ids.

Routing prefers the explicit `provider/model` form, then a bare id owned by an un-namespaced
provider, then a unique bare id, then `default_provider`.

Keys may be written either way: `api_key_env` names an environment variable, `api_key` holds the
value inline. If both are present the environment wins when it has a value, so a deployment can
override a key without editing the file, and the inline key is used otherwise. `config.json` is
git-ignored precisely so an inline key stays local; `config.example.json` is the shareable one.

## License

MIT. See [LICENSE](LICENSE); the original copyright notices are preserved.
