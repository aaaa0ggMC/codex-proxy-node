// Optional model-authored notes. The core automatically archives tool evidence; this tool adds
// decisions and progress that were never themselves returned by a source tool.
import { CONTEXT_TOOL } from "../../src/context.js";
import { toolName } from "../../src/sdk.js";

// The plugin owns its wire name; prose references are built through `ref`, so the prefix lives
// only in src/agent/names.js.
const NAME = "checkpoint";
const NAMESPACE = true;
const ref = (tool) => toolName(NAME, tool, { namespace: NAMESPACE });

// User-facing documentation for the console's plugin page. Plain Markdown; the console renders it
// with the small renderer in src/markdown.js.
const DOCS = [
  "# checkpoint",
  "",
  "An optional tool for the model to save a short note of decisions or progress.",
  "",
  "    user: remember which deck we were in when you answer",
  `          └── ${ref("save")} writes it, and the proxy hands it back on later turns`,
  "",
  "## Why it exists",
  "",
  "- The core already archives ordinary tool results automatically. No checkpoint is needed for",
  "  every document read or file path. This tool is for notes that do not exist in tool evidence.",
  "- Notes are not source evidence. Retrieve the original before quoting facts.",
  "",
  "## How it works",
  "",
  "- The tool's result carries a `<checkpoint>` block. The core lifts it out of the result, the",
  "  transport writes it into the conversation, and the next request re-appends it as a message the",
  "  model sees again.",
  "- Restore requires the client to keep either the checkpoint block or the core's latest thinking",
  "  reference. A checkpoint cannot recover a conversation whose references were all removed.",
  "",
  "## Notes",
  "",
  `- Use it for analysis progress and decisions; use \`${CONTEXT_TOOL}\` for retained originals.`,
  "- Keep a note short and stable: the same fact should always produce the same text, or the",
  "  provider's prompt prefix changes and its cache is lost.",
  "- It travels through the client's history and shows in its thinking panel, so keep secrets out",
  "  of it.",
  "",
].join("\n");

export default {
  name: NAME,
  namespace: NAMESPACE,
  docs: DOCS,
  tools: [
    {
      name: "save",
      description:
        `Optionally save a short note of decisions or progress for later turns. The core already archives local tool results automatically, so do not checkpoint every file read. A note is not source evidence: retrieve original tool results with ${CONTEXT_TOOL} before quoting facts. Restoring notes requires the client to preserve the thinking reference or checkpoint block.`,
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
