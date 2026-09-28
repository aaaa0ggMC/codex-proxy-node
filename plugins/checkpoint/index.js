// The checkpoint tool exists because of how this proxy runs, not because any particular plugin
// has something to say.
//
// A client may compact its history between turns, which drops old tool results: a file path, a
// document id, a decision, anything the model was told earlier can vanish. A model that knows this
// can save what it does not want to lose, and the proxy hands it back on later turns.
//
// Nothing here decides what is worth keeping. That judgement is the model's.
export default {
  name: "checkpoint",
  namespace: true,
  tools: [
    {
      name: "save",
      description:
        "Save a short note that must survive context compaction. This applies to the proxy_* tools only: the client shortens its history between messages and what gets dropped is their results, so anything you learned from proxy_docs_* or proxy_filesearch_* that you will need again belongs here — file paths, document ids, which page you were on, results that are expensive to re-derive. State held by the client's own tools does not need saving. Saved notes are handed back to you automatically on later turns; saving is free and repeating it is harmless.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "One short line. Keep it stable for the same fact, e.g. 'deck = /path/a.pptx (doc_1a2b)'",
          },
        },
        required: ["text"],
      },
      async run({ text }) {
        const value = String(text ?? "").trim();
        if (value === "") throw new Error("nothing to save");
        return `Saved. It will be given back to you automatically on later turns.\n<checkpoint>${value}</checkpoint>`;
      },
    },
  ],
};
