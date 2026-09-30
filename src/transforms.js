import { stringValue } from "./util.js";
import { note, stripWrapper } from "./notes.js";
import { carriedBlock, fenceSources, liftCarried } from "./sdk.js";
import { ImageRefRewriter } from "./images.js";

// Answer transforms: a plugin may claim a fenced code language and replace that fence with richer
// content (an image, a chart, anything the client renders). On the way back in, the same plugin
// restores its rendered form to the compact source, so the model keeps an accurate, cheap memory
// of what it drew instead of re-reading a megabyte of markup.
//
// The outbound side is a streaming rewriter, because a fence can be split across as many deltas as
// the provider likes: `feed()` passes ordinary text straight through and buffers only the inside of
// a claimed fence, which is the stretch a client cannot render anyway until it is complete.

// A fence opener: up to three spaces of indent, three or more backticks or tildes, then an info
// string. Only the first token of the info string is the language.
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9_+.-]*)/;
const FENCE_CLOSE = /^(\s*)(`{3,}|~{3,})\s*$/;

export class FenceRewriter {
  #languages;
  #render;
  #pending = "";
  #fence = null;

  constructor({ languages, render }) {
    this.#languages = languages instanceof Set ? languages : new Set(languages ?? []);
    this.#render = typeof render === "function" ? render : () => null;
  }

  get insideFence() {
    return this.#fence != null;
  }

  // feed consumes a chunk and returns the text that may go out now, plus the fenced sources that
  // were rendered and should ride the thinking channel as bookkeeping.
  feed(chunk) {
    if (typeof chunk !== "string" || chunk === "") return { text: "", notes: [] };
    this.#pending += chunk;
    const out = [];
    const notes = [];
    let index;
    while ((index = this.#pending.indexOf("\n")) !== -1) {
      const line = this.#pending.slice(0, index);
      this.#pending = this.#pending.slice(index + 1);
      this.#consume(line, true, out, notes);
    }
    return { text: out.join(""), notes };
  }

  // flush ends the answer: it returns whatever was still held back. A fence whose closing line had
  // no trailing newline is still closed properly; a genuinely unterminated fence is handed back
  // verbatim, because dropping the model's own text would be worse than an ugly fence.
  flush() {
    const out = [];
    const notes = [];
    if (this.#fence != null) {
      const close = FENCE_CLOSE.exec(this.#pending);
      if (close != null && close[2][0] === this.#fence.char && close[2].length >= this.#fence.length) {
        this.#pending = "";
        this.#closeFence(false, out, notes);
        this.#reset();
        return { text: out.join(""), notes };
      }
      out.push(this.#fence.head, "\n", this.#fence.body);
      if (this.#pending !== "") out.push(this.#pending);
      this.#reset();
      return { text: out.join(""), notes };
    }
    if (this.#pending !== "") {
      out.push(this.#pending);
      this.#pending = "";
    }
    return { text: out.join(""), notes };
  }

  #reset() {
    this.#fence = null;
    this.#pending = "";
  }

  #consume(line, hasNewline, out, notes) {
    if (this.#fence == null) {
      const open = FENCE_OPEN.exec(line);
      if (open != null) {
        const language = (open[3] ?? "").toLowerCase();
        if (language !== "" && this.#languages.has(language)) {
          this.#fence = { char: open[2][0], length: open[2].length, language, head: line, body: "" };
          return;
        }
      }
      out.push(hasNewline ? line + "\n" : line);
      return;
    }

    const close = FENCE_CLOSE.exec(line);
    if (close != null && close[2][0] === this.#fence.char && close[2].length >= this.#fence.length) {
      this.#closeFence(hasNewline, out, notes, line);
      this.#fence = null;
      return;
    }

    this.#fence.body += hasNewline ? line + "\n" : line;
  }

  #closeFence(hasNewline, out, notes, line = "") {
    const source = this.#fence.body.replace(/\n$/, "");
    const rendered = this.#safeRender(this.#fence.language, source);
    if (rendered != null) {
      out.push(hasNewline ? rendered + "\n" : rendered);
      notes.push({ language: this.#fence.language, source });
      return;
    }
    // The renderer declined (or threw): keep the fence so nothing the model wrote is lost.
    out.push(this.#fence.head, "\n", this.#fence.body, hasNewline ? line + "\n" : line);
  }

  #safeRender(language, source) {
    try {
      const rendered = this.#render(language, source);
      return typeof rendered === "string" && rendered !== "" ? rendered : null;
    } catch {
      return null;
    }
  }
}

function reasoningNote(text) {
  return {
    type: "response.reasoning_text.delta",
    data: { type: "response.reasoning_text.delta", delta: note(text) },
  };
}

// A rendered fence's source is carried, not ignored bookkeeping: the client stores it and the proxy
// lifts it back out as context on the next turn, so the model keeps a compact memory of the diagram
// it drew. This is the carried disposition of the thinking channel, the same rail checkpoints use.
function fenceNote({ language, source }) {
  return reasoningText(carriedBlock("plugin-fence", { name: language, body: source }));
}

// withLeadingInjection puts a plugin's contributions on the reasoning channel before the provider
// says anything:
//
//   carried  a block the client must keep and replay (a <plugin-inject> reference), emitted as-is
//            so it survives the client's history and is lifted back out on the next request
//   notes    bookkeeping only, wrapped in <ignore> so the transport strips it from the replay
export async function* withLeadingInjection({ carried = [], notes = [] }, events) {
  for (const block of carried) yield reasoningText(block);
  for (const text of notes) yield reasoningNote(text);
  yield* events;
}

// A carried block also shares the thinking channel with the model reasoning, so it is framed the
// same way a note is: on its own lines, never running into adjacent text.
function reasoningText(text) {
  return { type: "response.reasoning_text.delta", data: { type: "response.reasoning_text.delta", delta: `\n${text}\n` } };
}

// transformEvents wraps the provider's event stream and rewrites the assistant's answer text in
// place. Deltas stream through the rewriter; the finished message item is rewritten with the same
// accumulated text so the streaming and non-streaming paths agree on what the answer is.
export async function* transformEvents(events, { registry = null, disabledPlugins = [], include = [], origin = "" } = {}) {
  const gate = { exclude: disabledPlugins, include };
  const languages = registry?.fenceLanguages?.(gate) ?? new Set();
  const hasImages = registry?.hasImageResolver?.(gate) ?? false;
  if (languages.size === 0 && !hasImages) {
    yield* events;
    return;
  }

  const render = (language, source) => registry.renderFence(language, source, gate);
  const fresh = () => new FenceRewriter({ languages, render });
  const imageRewriter = hasImages
    ? new ImageRefRewriter((ref) => registry.resolveImage(ref, { ...gate, origin }))
    : null;
  // The image pass runs first, so a reference is resolved before the fence pass sees the text; the
  // fence pass still owns turning a claimed ```fence into its render.
  const pre = (text) => (imageRewriter == null || text === "" ? text : imageRewriter.feed(text).text);
  const flushAll = (rewriter) => {
    const tail = imageRewriter == null ? "" : imageRewriter.flush().text;
    if (tail !== "") rewriter.feed(tail);
    return rewriter.flush();
  };

  let rewriter = fresh();
  let answer = "";
  let sawDelta = false;

  for await (const event of events) {
    const type = event?.type;

    if (type === "response.output_text.delta") {
      const delta = stringValue(event?.data, "delta");
      if (delta === "") {
        yield event;
        continue;
      }
      sawDelta = true;
      const { text, notes } = rewriter.feed(pre(delta));
      for (const rendered of notes) yield fenceNote(rendered);
      if (text === "") continue;
      answer += text;
      yield { ...event, data: { ...event.data, delta: text } };
      continue;
    }

    if (type === "response.output_text.done") {
      // Some providers send the finished text here without ever streaming it as deltas.
      if (!sawDelta) {
        const raw = stringValue(event?.data, "text");
        if (raw !== "") {
          const whole = fresh();
          const raw2 = pre(raw) + (imageRewriter == null ? "" : imageRewriter.flush().text);
          const fed = whole.feed(raw2);
          const done = whole.flush();
          for (const rendered of [...fed.notes, ...done.notes]) yield fenceNote(rendered);
          yield { ...event, data: { ...event.data, text: fed.text + done.text } };
          continue;
        }
      }
      // Otherwise hand any held-back tail downstream before the done event, so a delta-only client
      // (chat) does not lose the end of a fence.
      const { text, notes } = flushAll(rewriter);
      for (const rendered of notes) yield fenceNote(rendered);
      if (text !== "") {
        answer += text;
        yield { type: "response.output_text.delta", data: { type: "response.output_text.delta", delta: text } };
      }
      if (answer !== "") yield { ...event, data: { ...event.data, text: answer } };
      else yield event;
      continue;
    }

    if (type === "response.output_item.done") {
      const item = event?.data?.item;
      const { text, notes } = flushAll(rewriter);
      for (const rendered of notes) yield fenceNote(rendered);
      if (text !== "") {
        answer += text;
        yield { type: "response.output_text.delta", data: { type: "response.output_text.delta", delta: text } };
      }

      if (item != null && typeof item === "object" && stringValue(item, "type") === "message") {
        if (sawDelta) {
          replaceMessageText(item, answer);
        } else {
          // The provider only sent the finished item: rewrite it from scratch.
          const whole = fresh();
          const raw2 = pre(messageText(item)) + (imageRewriter == null ? "" : imageRewriter.flush().text);
          const fed = whole.feed(raw2);
          const done = whole.flush();
          for (const rendered of [...fed.notes, ...done.notes]) yield fenceNote(rendered);
          replaceMessageText(item, fed.text + done.text);
        }
      }

      // An item ends a text segment. Whether or not it was a message, the next turn starts clean,
      // and a later message item is re-transformed from its own text.
      rewriter = fresh();
      answer = "";
      sawDelta = false;
      yield event;
      continue;
    }

    if (type === "response.completed") {
      const { text, notes } = flushAll(rewriter);
      for (const rendered of notes) yield fenceNote(rendered);
      if (text !== "") {
        yield { type: "response.output_text.delta", data: { type: "response.output_text.delta", delta: text } };
      }
      rewriter = fresh();
      answer = "";
      sawDelta = false;
      yield event;
      continue;
    }

    yield event;
  }

  // The stream ended without a completion marker: flush whatever a client may still be waiting for.
  const { text, notes } = flushAll(rewriter);
  for (const rendered of notes) yield fenceNote(rendered);
  if (text !== "") {
    yield { type: "response.output_text.delta", data: { type: "response.output_text.delta", delta: text } };
  }
}

function messageText(item) {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter((part) => part != null && typeof part === "object" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function replaceMessageText(item, text) {
  if (!Array.isArray(item.content)) {
    item.content = [{ type: "output_text", text, annotations: [], logprobs: [] }];
    return;
  }
  let replaced = false;
  for (const part of item.content) {
    if (part == null || typeof part !== "object" || typeof part.text !== "string") continue;
    part.text = replaced ? "" : text;
    replaced = true;
  }
  if (!replaced) item.content.push({ type: "output_text", text, annotations: [], logprobs: [] });
}

// restoreResponseInput is the inbound half for the Responses endpoint. It rewrites assistant text
// parts back to their source form, and strips proxy bookkeeping from replayed reasoning items so a
// note we wrote never travels back upstream.
export function restoreResponseInput(input, { registry = null, disabledPlugins = [], include = [] } = {}) {
  if (registry == null || !Array.isArray(input)) return input;
  const carried = [];
  // The fence sources collected so far let a renderer put the model's own text back where its
  // generated markup stood; for the Responses rail the reasoning item is replayed before the
  // assistant message, so the source is available by the time the answer is restored.
  const restore = (text) =>
    registry.restore(text, { exclude: disabledPlugins, include, fences: fenceSources(carried) });

  for (const item of input) {
    if (item == null || typeof item !== "object") continue;
    const isAssistant = item.role === "assistant";
    const isReasoning = stringValue(item, "type") === "reasoning";

    const lift = (text) => {
      const found = liftCarried(text);
      carried.push(...found.blocks);
      return stripWrapper(found.cleaned);
    };

    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part == null || typeof part !== "object" || typeof part.text !== "string") continue;
        const type = stringValue(part, "type");
        if (isReasoning) {
          if (type === "reasoning_text" || type === "summary_text") part.text = lift(part.text);
        } else if (isAssistant) {
          if (type === "output_text" || type === "input_text" || type === "text") part.text = restore(part.text);
        }
      }
    } else if (typeof item.content === "string") {
      if (isReasoning) item.content = lift(item.content);
      else if (isAssistant) item.content = restore(item.content);
    }
  }

  // Only state the model must keep is re-injected; a <plugin-fence> exists to restore the model's own
  // text above, and re-injecting it would reveal that the answer was processed.
  const keep = carried.filter((block) => block.tag !== "plugin-fence").map((block) => block.body);
  if (keep.length > 0) {
    const unique = [...new Set(keep)];
    input.push({ role: "developer", content: `Context carried over from earlier turns:\n${unique.join("\n")}` });
  }
  return input;
}
