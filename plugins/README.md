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
