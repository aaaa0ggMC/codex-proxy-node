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
        "Save a short note that must survive context compaction. The client may shorten or drop earlier turns between messages, so anything you will need later — file paths, document ids, decisions, results you cannot cheaply re-derive — belongs here. Saved notes are handed back to you automatically as context on later turns. Saving is free and repeating it is harmless.",
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
