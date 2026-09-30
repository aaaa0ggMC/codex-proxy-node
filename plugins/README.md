# Plugins

A plugin is a folder here. Create `plugins/<name>/index.js`, default-export an object, and its
tools are offered to the model the next time the proxy starts. Nothing else to register.

Folders are recognised by name, so nothing has to be moved around:

| Name | Effect |
| --- | --- |
| `docs` | loaded |
| `-docs` | **disabled**: skipped, and logged as disabled so you can see the rename took |
| `_docs`, `.docs` | skipped silently (the shipped example uses `_example`) |

## Contract

```js
export default {
  name: "docs",            // required
  namespace: false,        // optional: opt out of the proxy_<plugin>_<tool> prefix
  docs: "…",               // optional: a Markdown page for people, shown in the console
  instructions: "…",       // optional: a Skill's prompt fragment, added to the cached prefix
  context: "auto",         // default: core archives tool results; "manual" opts out
  ingestFile: async ({ filename, data }) => "…",   // optional: read a chat attachment
  fences: {                // optional: render a fenced block in the answer (see transforms)
    mermaid: (source, ctx) => "…",
  },
  restoreText: (text, ctx) => text,   // optional: undo a fence on the way back in
  lore: "…",               // optional: supplementary module reference (not required for activation)
  contribute: (ctx) => ({ append: […], notes: […] }),   // optional: tail context per request
  tools: [
    {
      name: "read_page",
      description: "Read one page as text and an image",
      parameters: { type: "object", properties: { page: { type: "number" } }, required: ["page"] },
      docs: "…",           // optional: a Markdown page for people, shown in the console
      timeoutMs: 30_000,   // optional, defaults to 60s
      context: "auto",     // optional per-tool override of the plugin's policy
      async run(args, ctx) {
        // Return a string, or content parts the model can see:
        return [
          { type: "input_text", text: "page 1" },
          { type: "input_image", image_url: "data:image/png;base64,…", detail: "high" },
        ];
      },
    },
  ],
};
```

Returning `input_image` is how a tool hands the model a picture — for example a rendered slide.

## Automatic context (the default)

Ordinary plugins do not manage conversation history. Return text or content parts from `run`:
the core archives the exact normalized result and its tool name/arguments, including failures.
It also retains attachment ingestion results, contributed content and carried fence/checkpoint
notes. No plugin import, extra tool call or generated summary is required.

The core emits a short `<proxy-context>` capability only on the thinking channel. On replay it
restores small results as historical tool outputs and supplies an index for large results/media.
`proxy_context_read` reads original text by offset, or a selected image/audio part, without
re-running the originating tool. It is reserved by the core; do not declare a tool with that name.
Long tool text is explicitly excerpted only after its original has been stored. Notes are marked
as notes, not source evidence.

This works with Chat Completions and Responses, streaming or aggregated. A reply renews the
reference even if no new tool was called. Snapshots are immutable, so branching a conversation
does not change its sibling. Clients must preserve at least the latest thinking reference; a
proxy cannot recover a conversation identity if every reference has been deleted. Cache limits,
restart persistence and retrieval limits are documented in the [main README](../README.md#plugin-context-across-turns).

For advanced tools, set `context: "manual"` on the tool or plugin. Tool settings override plugin
settings. This disables automatic archival/excerpting for those tool results, but does not remove
previous evidence or disable explicit hooks. `contribute`, `restoreText`, `instructions` and the
carried-block SDK remain available when a plugin needs direct control. Default plugins should
not implement their own session maps or checkpoint every read.

## The console

`GET /admin/plugins` is a small console (also reachable through MCPHub at
`/apps/<id>/admin/plugins`). It lists every plugin with a toggle, and every plugin and tool is a
link into a detail page:

- a **tool page** shows the exact declaration the model is given — the namespaced name, description
  and parameter schema — followed by the tool's own documentation;
- a **plugin page** shows the plugin's documentation and its tools.

The documentation comes from `docs` strings (`plugin.docs`, `tool.docs`), rendered with the small
Markdown subset in `src/markdown.js`: headings, paragraphs, lists, block quotes, fenced and indented
code, rules, links, bold and italic. HTML in a document is escaped, never executed, and a link that
could run code (`javascript:`) is dropped. Write docs for the person using the plugin, not for the
model: the model's view is the `description` and `parameters`, which are shown above your prose.

## Answer transforms

A plugin may claim a fenced code language. When the model writes such a fence in its answer, the
proxy holds that block back, hands the source to `renderFence`, and streams the returned markdown in
its place — so a client sees a picture where the model wrote a few lines of mermaid.

The model must not see the rewrite. On the way back in, the transport lifts the replayed
`<plugin-fence>` blocks, strips them from thinking, and hands their sources to the renderer's
`restoreText`. That puts the model's own fence back where the rendered markup stood, so a replayed
conversation shows the model exactly what it wrote. The block is never re-injected as context, so
nothing tells the model its answer was processed.

A renderer therefore implements `restoreText(text, { fences })`: `fences` is a `Map` from language to
the sources carried for it, and the return value is the compact text the model wrote. Keep a small
render → source memory so a restore needs no re-parse, and fall back to `fences` so a proxy restart,
which loses that memory, still restores correctly.

```js
export default {
  name: "flowchart",
  namespace: false,
  fences: { mermaid: renderMermaid },  // the markdown the client shows in place of the fence
  restoreText: restoreDiagram,         // the model's own ```mermaid fence again, on replay
};
```

Rules for a renderer:

- **Implement `restoreText`.** It is what keeps the model unaware of the rewrite; the sources come
  from the carried `<plugin-fence>` blocks, which are never shown to the model.
- **Return `null` to decline.** An unknown shape, unreadable source, or a thrown error all leave the
  fence exactly as the model wrote it, which beats showing the user a broken picture.
- **Both endpoints are covered.** The transform sits on the provider event stream, so chat
  Completions and the Responses API stream and aggregate identically; the carried source is lifted
  on both the chat replayer and the Responses input.
- **Keep it deterministic.** The rendered bytes are part of what a client stores and replays, so a
  random id or timestamp inside the output would look like the conversation changed. The flowchart
  plugin derives its SVG filter ids from the laid-out graph for that reason.
- **No secrets.** The source rides the thinking channel and travels through the client's history.

## Answer images

A plugin may claim markdown image references in the model's answer. The model writes
`![what it is|visible](src)` — or `|invisible`, the default — and the first enabled plugin with an
`images.resolve(ref, ctx)` hook returns the markdown the client should see, or `null` to leave the
reference untouched. `ref` is `{ alt, visible, src }`; `ctx` carries the request `origin`, so a
resolved URL can be absolute. The spans are found by a streaming rewriter (src/images.js), so a
reference may be split across deltas.

[image-design](image-design/index.js) implements this and declares no tools. It resolves an
http(s) URL, a `data:` URI, or an `img_...` handle — minted by the core for any image a tool
returned — and serves stored bytes under `/media/<id>`. On the way back in, a `visible` image is
re-attached to the model as a picture and an `invisible` one becomes a short receipt claiming only
what the proxy can vouch for: `[sent image: what it was (img_ab12)]` for bytes it stored and serves
itself, `[image link: what it was (url)]` for an outside URL it merely passed along. So the model
re-sees only what it asked to keep, yet still knows a picture actually went out, and a reference the
proxy never rewrote is left as the model wrote it. The disposition rides the URL fragment
(`#visible`), which the client never sends, so it survives a restart without server-side per-image state.
## Activating a whole module

A user message containing `@plugin:<name>` activates the entire loaded plugin for that
conversation, including tools, instructions and transforms. It overrides the plugin's global
disabled default without changing the global setting. `<enable_module>name</enable_module>` is
equivalent. Mentions and explicit enable/disable tags are applied in conversation order; the
last operation wins. Only user messages count.

The core also attaches the module's reference: its `instructions`, optional supplementary `lore`,
and the names/descriptions of its tools. **No `lore` field is required.** The `docs` fields are the
console's pages for people and are never injected. Exact tool names and schemas are provided through
the tool declarations, not inferred from reference text. This works without the
`mentions` helper plugin. Unknown or unloaded modules cannot be enabled this way.

The reference is attached once and carried in thinking as `<plugin-inject>`. The core archive
retains it alongside other plugin context. See [mentions](mentions/README.md).

`contribute(ctx)` remains an optional advanced hook for dynamic context. Returning
`{ append: [message, …], notes: [string, …], carried: [string, …] }` adds messages to the request,
bookkeeping to thinking and explicit carried blocks. It is synchronous and should remain a pure
function of the request. Ordinary module activation needs no custom contributor.

## The SDK: writing into thinking and lifting it back out

Everything the proxy writes into the thinking channel is the same mechanism with one of two
dispositions:

- **`ignored`** — bookkeeping. The client stores and shows it, the proxy strips it on replay. Web
  search phases, tool progress notes and the mermaid source the flowchart plugin shows are all this.
- **`carried`** — context. The client stores it, and the proxy lifts it back out on the next request.
  Checkpoints, plugin-injected references and a rendered fence's source are this.

These optional blocks carry their bodies in client history. Separately, the core's automatic
archive stores exact tool evidence locally and carries only a `<proxy-context>` reference. One
parser in `src/sdk.js` owns the explicit block rails, so `<ignore>`, `<checkpoint>`, `<plugin-inject>` and
`<plugin-fence>` are one mechanism rather than four. A plugin that uses the SDK is complete on both
rails; nothing in the transport needs to know about the plugin.

```js
import { attachOnce, userText, carriedBlock, hasCarried, parseCarried, CARRIED_TAGS } from "../../src/sdk.js";
```

| Export | What it is for |
| --- | --- |
| `IGNORED` / `CARRIED` | The two dispositions. |
| `write(disposition, { tag, name, body })` | Emit a block for a disposition without knowing which tag it implies. |
| `ignored(body)` | The bookkeeping wire form: `<ignore>body</ignore>`. |
| `read(text, { carried, ignored })` | The one parser: returns the text with the proxy's own writes removed, plus what each rail held. |
| `unwrap(text)` / `normalize(text)` | Drop the folded `<th>/<mth>` envelope, collapse the whitespace a removed block leaves. |
| `carriedBlock(tag, { name, body })` | The carried wire form: `<tag name="…">\nbody\n</tag>`. |
| `parseCarried(text)` | Split a replayed message into `{ cleaned, blocks }`, so content is never fed twice. |
| `hasCarried(text, { tag, name })` | Is a block already in this history? |
| `attachOnce(input, entries)` | The whole pattern: returns `{ append, carried }` for the entries the client does **not** already hold, or `null`. |
| `userText(input)` | Only what the user wrote — a trigger the assistant echoes must not re-arm it. |
| `contextText(input)` | Everything replayed, so a presence check sees the content on either rail. |
| `CARRIED_TAGS` | The tags the SDK recognises, outbound and inbound. |

The two rails:

- **Outbound** — the core emits each `carried` block on the reasoning channel as-is, so the client
  stores it next to the answer.
- **Inbound** — `parseCarried` runs over replayed thinking (both transports) and the blocks come back
  as a developer message, so the model keeps what the client kept.

`<checkpoint>`, `<plugin-inject>` and `<plugin-fence>` are the carried tags. **Adding a tag to
`CARRIED_TAGS` is the whole change** — it then works outbound, inbound and for the "already there"
check with no other edit. That is the point of the SDK: keep it complete and every plugin that uses
it is complete too.

`src/notes.js` (the `<ignore>` rail) and `src/checkpoints.js` (the `<checkpoint>` rail) are now thin
wrappers over `read`/`write`; they exist for their callers, not as separate mechanisms.

A minimal plugin is then a trigger plus one call:

```js
import { attachOnce, userText } from "../../src/sdk.js";

export default {
  name: "mydata",
  lore: "mydata columns: id, name, created_at.",
  contribute({ input, registry }) {
    if (!userText(input).includes("@mydata")) return null;
    return attachOnce(input, [{ tag: "plugin-inject", name: "mydata", body: registry.lore("mydata") }]);
  },
};
```

## The rules that keep the prompt cache warm

Providers cache by prompt *prefix*, so anything this system puts in a request must be identical
for identical client input:

- **Tool order is sorted by folder name**, on purpose. Do not make the tool set depend on the
  request; a plugin that only appears sometimes shifts the prefix and costs cache hits every turn.
- **Do not generate ids randomly.** Anything the proxy writes into a request that a client will
  send again has to be reproducible (see `stableId` in `src/util.js`).
- **`instructions` is prefix**, so it must be identical on every request while the plugin is
  loaded. Per-request context belongs at the tail of the newest message, not here.
- **Reloading is explicit.** Restart the proxy to pick up changes; there is no file watcher,
  because swapping tools mid-conversation invalidates the cache for that conversation.
- **A broken plugin is skipped, not fatal.** Load and registration errors are logged and the proxy
  keeps serving.

## Checkpoints: state that survives a compacted history

A checkpoint is an optional note of progress, decisions or other state a model/plugin wants to
preserve. The core already archives ordinary tool results automatically; checkpoints are not
required for file paths, document ids or source text returned by tools. Notes are not a substitute
for reading original evidence. Explicit checkpoints remain available for advanced context control.

A tool result may contain a `<checkpoint>…</checkpoint>` block:

```js
async run({ path }) {
  const doc = await open(path);
  return `opened ${doc.id}\n<checkpoint>${doc.id} = ${path} (${doc.pages} pages)</checkpoint>`;
}
```

What the core does with it:

- the loop lifts the block out of the tool result and hands it to the transport;
- the transport writes it into the folded thinking block, **outside `<ignore>`** — a checkpoint is
  content, not bookkeeping, so it is not stripped;
- on the next request the proxy extracts any `<checkpoint>` from the replayed thinking or content
  and re-appends it as a `developer` message, so the model gets it back.

Rules for a plugin that emits one:

- **Keep it small and stable.** The same situation must produce the same text, or the prompt prefix
  changes and the cache is lost.
- **It is appended at the tail**, never merged into `instructions`, for the same reason.
- **Say only what cannot be re-derived cheaply.** A checkpoint exists because re-finding the
  information is expensive; anything a tool can look up again belongs in the tool, not here.
- **No secrets.** It travels through the client's history and is visible in its thinking panel.
