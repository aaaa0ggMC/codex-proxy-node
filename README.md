# codex-proxy (Node)

A small local OpenAI-compatible proxy backed by your existing Codex CLI ChatGPT login.

```text
OpenAI-compatible client -> http://127.0.0.1:6769/v1 -> ChatGPT Codex backend
```

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

To listen on a non-loopback interface you must set a proxy API key. Prefer the environment variable
on shared systems, because `--api-key` shows up in shell history and process lists:

```bash
CODEX_PROXY_API_KEY='replace-with-a-long-random-key' node src/index.js --host 0.0.0.0 --port 6769
```

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness probe. Never touches the upstream. |
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

The `/v1/responses` route stays a pass-through, so it forwards whatever content parts the caller
sends.

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

## License

MIT. See [LICENSE](LICENSE); the original copyright notices are preserved.
