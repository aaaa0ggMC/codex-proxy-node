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
  namespace: true,         // optional: tool names become docs__<tool>
  instructions: "…",       // optional: a Skill's prompt fragment
  ingest: async (parts, ctx) => parts,   // optional: rewrite attachment content
  tools: [
    {
      name: "read_page",
      description: "Read one page as text and an image",
      parameters: { type: "object", properties: { page: { type: "number" } }, required: ["page"] },
      timeoutMs: 30_000,   // optional, defaults to 60s
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

A client that compacts its conversation drops old tool results, so a model forgets the document id
it was given and starts over. The proxy supports one mechanism against that; **deciding whether to
use it is the plugin's own call**, and the proxy only moves the data.

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
