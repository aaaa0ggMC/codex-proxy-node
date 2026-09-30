import { stringValue } from "../util.js";
import { extractCheckpoints } from "../checkpoints.js";
import { CONTEXT_TOOL, contextInstructions, contextTool } from "../context.js";
import { parseDataURI, putImage } from "../media.js";

// The agent loop: ask the provider for a turn, run whatever tools are ours, feed the results back,
// and repeat. Anything the model asks a *client* to run is streamed straight through and ends the
// loop, because the client owns that tool and we must not run it on its behalf.

function asFunctionCall(item) {
  if (item == null || typeof item !== "object") return null;
  if (stringValue(item, "type") !== "function_call") return null;
  return item;
}

function callIdOf(call) {
  const id = stringValue(call, "call_id");
  return id !== "" ? id : stringValue(call, "id");
}

// inputStats reports what a turn will carry, which is what the cache analysis needs: how much of
// the prompt is images, and how many tool results are being replayed.
// instructions and the tool declarations are part of the prompt but are not items in `input`, so
// they are counted separately: otherwise a huge system prompt looks like missing tokens.
export function inputStats(input, request = null) {
  let images = 0;
  let characters = 0;
  let outputs = 0;
  for (const item of input) {
    if (item?.type === "function_call_output") {
      outputs += 1;
      if (Array.isArray(item.output)) {
        for (const part of item.output) {
          if (part.type === "input_image") images += 1;
          else characters += String(part.text ?? "").length;
        }
      } else {
        characters += String(item.output ?? "").length;
      }
    } else if (Array.isArray(item?.content)) {
      for (const part of item.content) {
        if (part.type === "input_image") images += 1;
        else characters += String(part.text ?? "").length;
      }
    } else {
      characters += String(item?.content ?? "").length;
    }
  }
  const instructions = request == null ? 0 : String(request.instructions ?? "").length;
  const tools = request == null || !Array.isArray(request.tools) ? 0 : JSON.stringify(request.tools).length;
  return { items: input.length, images, characters, outputs, instructions, tools };
}

// discardOldImages is the compaction policy under test: keep the images from the last `keep` tool
// results and drop the rest. It shrinks the prompt, but it also rewrites the middle of the
// conversation, which is exactly what a prefix cache cannot forgive.
export function discardOldImages(input, keep) {
  if (keep <= 0) return input;
  const outputIndexes = [];
  input.forEach((item, index) => {
    if (item?.type === "function_call_output" && Array.isArray(item.output)) outputIndexes.push(index);
  });
  const drop = new Set(outputIndexes.slice(0, Math.max(0, outputIndexes.length - keep)));
  if (drop.size === 0) return input;
  return input.map((item, index) => {
    if (!drop.has(index)) return item;
    const output = item.output.filter((part) => part.type !== "input_image");
    return { ...item, output: output.length > 0 ? output : "[images removed to save context]" };
  });
}

// mergeTools appends the local tool declarations after the client's, skipping any name the client
// already declared: a client-owned tool always wins, so a plugin can never hijack it.
export function mergeTools(clientTools, localTools) {
  const existing = Array.isArray(clientTools) ? clientTools : [];
  const taken = new Set(
    existing.map((tool) => (tool != null && typeof tool === "object" ? stringValue(tool, "name") : "")).filter(Boolean),
  );
  const additions = localTools.filter((tool) => !taken.has(tool.name));
  if (additions.length === 0) return existing;
  return [...existing, ...additions];
}

// runAgent yields provider events for the caller to forward downstream. Local tool calls are
// swallowed (the client must never see them), executed, and replayed back to the provider.
export async function* runAgent({
  stream,
  request,
  registry,
  signal,
  // A long document walk is many turns; this is only a guard against a runaway loop.
  maxTurns = 256,
  log = null,
  discardImages = 0,
  disabledPlugins = [],
  includedPlugins = [],
  context = null,
}) {
  const gate = { exclude: disabledPlugins, include: includedPlugins };
  const clientNames = new Set((request.tools ?? []).map((tool) => tool?.name));
  const localTools = (registry == null ? [] : registry.definitions(gate)).filter((tool) => !clientNames.has(tool.name));
  if (context != null) {
    if (clientNames.has(CONTEXT_TOOL) || localTools.some((tool) => tool.name === CONTEXT_TOOL)) {
      throw new Error(`${CONTEXT_TOOL} is reserved for core context retrieval`);
    }
    localTools.push(contextTool);
  }
  const localNames = new Set(localTools.map((tool) => tool.name));
  const localInstructions = registry == null ? [] : registry.instructions(gate);
  if (context != null) localInstructions.push(contextInstructions);

  // Tool declarations and plugin instructions are both part of the prompt prefix, and both are
  // stable for as long as the plugin set is, so they can be merged in without costing cache hits
  // from turn to turn.
  const base = { ...request, tools: mergeTools(request.tools, localTools) };
  if (localInstructions.length > 0) {
    const own = stringValue(request, "instructions");
    const fragment = localInstructions.join("\n\n");
    base.instructions = own === "" ? fragment : `${own}\n\n${fragment}`;
  }

  let input = request.input;
  // One client request can take several upstream turns (a local tool call, then the answer). Each
  // turn reports its own usage, so the total is summed and attached to the completion the client
  // finally sees — reporting only the last turn understates the real cost.
  let usageTotal = null;
  for (let turn = 0; ; turn++) {
    if (discardImages > 0) {
      const compacted = discardOldImages(input, discardImages);
      if (compacted !== input) log?.info("context compacted", { turn, ...inputStats(compacted) });
      input = compacted;
    }
    const calls = [];
    const hiddenItems = new Set();
    let handedBack = false;
    let finished = null;

    const stats = inputStats(input, base);
    log?.info("turn started", { turn, ...stats });

    // Resolve the stream first: an async provider wrapper returns a promise of an iterable, and
    // awaiting it here is what lets the handler see an upstream error as a plain throw.
    const events = await stream({ ...base, input }, signal);
    for await (const event of events) {
      if (event?.type === "response.output_item.added" && event.data?.item?.type === "function_call"
          && localNames.has(event.data.item.name)) {
        if (event.data.item.id) hiddenItems.add(event.data.item.id);
        continue;
      }
      if (event?.type?.startsWith("response.function_call_arguments.") && hiddenItems.has(event.data?.item_id)) continue;
      if (event?.type === "response.completed") {
        // Hold the completion: whether the client should see it depends on what we do next.
        finished = event;
        const usage = event.data?.response?.usage;
        if (usage != null) {
          usageTotal = accumulateUsage(usageTotal, usage);
          log?.info("turn completed", {
            turn,
            prompt_tokens: usage.input_tokens,
            cache_hit_tokens: usage.input_tokens_details?.cached_tokens,
            output_tokens: usage.output_tokens,
          });
        }
        continue;
      }
      if (event?.type === "response.failed" || event?.type === "response.incomplete") {
        yield event;
        return;
      }
      const call = asFunctionCall(event?.type === "response.output_item.done" ? event.data?.item : null);
      if (call == null) {
        yield event;
        continue;
      }
      calls.push(call);
      if (!localNames.has(stringValue(call, "name"))) {
        // The client owns this one: forward the call and let the loop end.
        handedBack = true;
        yield event;
      }
    }
    const localCalls = calls.filter((call) => localNames.has(stringValue(call, "name")));
    if (localCalls.length === 0 || (!handedBack && turn + 1 >= maxTurns)) {
      if (finished != null) yield withUsage(finished, usageTotal);
      return;
    }

    const outputs = [];
    for (const call of localCalls) {
      const callId = callIdOf(call);
      // Tell the caller a tool is about to run. The transport decides whether that becomes visible
      // progress or stays internal; either way the caller knows the gap is not a stall.
      yield {
        type: "codex_proxy.tool_start",
        data: {
          type: "codex_proxy.tool_start",
          name: stringValue(call, "name"),
          arguments: stringValue(call, "arguments"),
          call_id: callId,
        },
      };
      try {
        const name = stringValue(call, "name");
        let output;
        if (name === CONTEXT_TOOL && context != null) {
          output = await context.read(JSON.parse(call.arguments || "{}"));
        } else {
          // A tool can take a minute (LibreOffice rendering, a PDF page). Its progress is streamed
          // as it happens instead of leaving the client on a silent socket.
          const queue = progressQueue();
          const work = registry.call(name, call.arguments, { signal, progress: (text) => queue.push(text) });
          work.then(() => queue.close(), () => queue.close());
          for (;;) {
            const text = await queue.next();
            if (text == null) break;
            yield { type: "codex_proxy.progress", data: { type: "codex_proxy.progress", name, text } };
          }
          output = await work;
        }
        // A tool may hand back a checkpoint: it rides the client's thinking channel out and is
        // lifted back in as context, so it survives even if this tool result is compacted away.
        const found = extractCheckpoints(textOf(output));
        if (found.blocks.length > 0) {
          yield { type: "codex_proxy.checkpoint", data: { type: "codex_proxy.checkpoint", blocks: found.blocks } };
        }
        outputs.push({ type: "function_call_output", call_id: callId, output: visibleOutput(withImageHandles(output)) });
      } catch (err) {
        // A failing tool is information, not a dead end: tell the model what went wrong.
        outputs.push({
          type: "function_call_output",
          call_id: callId,
          output: `Tool ${stringValue(call, "name")} failed: ${err.message}`,
        });
      }
      // Persist successful results and failures alike, outside the tool error handler. A storage
      // failure must not be misreported as a tool failure (the action may already have succeeded).
      const name = stringValue(call, "name");
      if (context != null && name !== CONTEXT_TOOL && registry?.contextPolicy(name) !== "manual") {
        const result = outputs.at(-1);
        const entry = await context.record(name, call.arguments, result.output);
        result.output = context.present(result.output, entry);
        // Save a usable reference before the next upstream request: if that request fails or the
        // client stops generation, results of actions that already happened remain recoverable.
        yield { type: "codex_proxy.context_saved", data: {} };
      }
    }
    if (handedBack) {
      // A parallel batch may mix client and local tools. Complete and archive the local work
      // before handing control back; otherwise its hidden calls would simply disappear.
      if (finished != null) yield withUsage(finished, usageTotal);
      return;
    }
    input = [...input, ...localCalls.map(echoCall), ...outputs];
  }
}

// Sum one turn of usage into the running total. The nested detail objects (cached input, reasoning
// output) are summed field-wise; everything else from the latest turn is kept as-is.
function accumulateUsage(total, usage) {
  const add = (a, b) => (Number(a) || 0) + (Number(b) || 0);
  return {
    ...(total ?? {}),
    ...usage,
    input_tokens: add(total?.input_tokens, usage.input_tokens),
    output_tokens: add(total?.output_tokens, usage.output_tokens),
    total_tokens: add(total?.total_tokens, usage.total_tokens),
    input_tokens_details: {
      ...(total?.input_tokens_details ?? {}),
      ...(usage.input_tokens_details ?? {}),
      cached_tokens: add(total?.input_tokens_details?.cached_tokens, usage.input_tokens_details?.cached_tokens),
    },
    output_tokens_details: {
      ...(total?.output_tokens_details ?? {}),
      ...(usage.output_tokens_details ?? {}),
      reasoning_tokens: add(total?.output_tokens_details?.reasoning_tokens, usage.output_tokens_details?.reasoning_tokens),
    },
  };
}

function withUsage(event, usage) {
  const response = event?.data?.response;
  if (usage == null || response == null || typeof response !== "object") return event;
  return { ...event, data: { ...event.data, response: { ...response, usage } } };
}

// A tool reports progress through ctx.progress; the tool runs while the loop drains this queue, so
// the text streams out as it is produced instead of after the tool returns.
function progressQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  const signal = () => { if (wake != null) { const resume = wake; wake = null; resume(); } };
  return {
    push(text) {
      const value = String(text ?? "").trim();
      if (value === "") return;
      items.push(value);
      signal();
    },
    close() {
      closed = true;
      signal();
    },
    async next() {
      while (items.length === 0 && !closed) await new Promise((resolve) => { wake = resolve; });
      return items.shift() ?? null;
    },
  };
}

function textOf(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output
    .filter((part) => part !== null && typeof part === "object" && part.type === "input_text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

// A tool that returns an image gives the model a short handle for it, so it can point the user at
// the picture without pasting base64 (which it cannot reproduce) and without inventing a
// placeholder like ![](image). The image-design plugin resolves the handle in the answer.
function withImageHandles(output) {
  const parts = Array.isArray(output) ? output : null;
  const images = (parts ?? []).filter((part) => part != null && typeof part === "object" && part.type === "input_image");
  if (images.length === 0) return output;
  const handles = [];
  for (const part of images) {
    const data = parseDataURI(part.image_url);
    if (data == null) continue;
    const id = putImage(data.base64, data.mime);
    if (id != null) handles.push(id);
  }
  if (handles.length === 0) return output;
  const hint = `[image handle${handles.length > 1 ? "s" : ""}: ${handles.join(", ")} — show one to the user with ![what it is|invisible](<handle>)]`;
  if (typeof output === "string") return `${output}\n${hint}`;
  return [...parts, { type: "input_text", text: hint }];
}

// A tool may return a carried block (a checkpoint, a fence source) as a way to reach the thinking
// channel. That markup is transport-only: it is lifted above, and the content comes back to the
// model through the carried rail. Feeding the raw block back or archiving it would show the model
// tags it never wrote and duplicate what that rail already re-injects.
function visibleOutput(output) {
  if (typeof output === "string") return extractCheckpoints(output).cleaned;
  if (Array.isArray(output)) {
    return output.map((part) =>
      part != null && typeof part === "object" && part.type === "input_text" && typeof part.text === "string"
        ? { ...part, text: extractCheckpoints(part.text).cleaned }
        : part);
  }
  return output;
}

function echoCall(call) {
  const out = {
    type: "function_call",
    call_id: callIdOf(call),
    name: stringValue(call, "name"),
    arguments: stringValue(call, "arguments") || "{}",
  };
  return out;
}
