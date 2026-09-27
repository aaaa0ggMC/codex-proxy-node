import { stringValue } from "../util.js";

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
export function inputStats(input) {
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
  return { items: input.length, images, characters, outputs };
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
export async function* runAgent({ stream, request, registry, signal, maxTurns = 4, log = null, discardImages = 0 }) {
  const localTools = registry == null ? [] : registry.definitions();
  const localNames = new Set(localTools.map((tool) => tool.name));
  const tools = mergeTools(request.tools, localTools);
  const base = tools.length > 0 ? { ...request, tools } : request;

  let input = request.input;
  for (let turn = 0; ; turn++) {
    if (discardImages > 0) {
      const compacted = discardOldImages(input, discardImages);
      if (compacted !== input) log?.info("context compacted", { turn, ...inputStats(compacted) });
      input = compacted;
    }
    const calls = [];
    let handedBack = false;
    let finished = null;

    const stats = inputStats(input);
    log?.info("turn started", { turn, ...stats });

    // Resolve the stream first: an async provider wrapper returns a promise of an iterable, and
    // awaiting it here is what lets the handler see an upstream error as a plain throw.
    const events = await stream({ ...base, input }, signal);
    for await (const event of events) {
      if (event?.type === "response.completed") {
        // Hold the completion: whether the client should see it depends on what we do next.
        finished = event;
        const usage = event.data?.response?.usage;
        if (usage != null) {
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
    if (handedBack) {
      if (finished != null) yield finished;
      return;
    }

    const localCalls = calls.filter((call) => localNames.has(stringValue(call, "name")));
    if (localCalls.length === 0 || turn + 1 >= maxTurns) {
      if (finished != null) yield finished;
      return;
    }

    const outputs = [];
    for (const call of localCalls) {
      const callId = callIdOf(call);
      try {
        const output = await registry.call(stringValue(call, "name"), call.arguments, { signal });
        outputs.push({ type: "function_call_output", call_id: callId, output });
      } catch (err) {
        // A failing tool is information, not a dead end: tell the model what went wrong.
        outputs.push({
          type: "function_call_output",
          call_id: callId,
          output: `Tool ${stringValue(call, "name")} failed: ${err.message}`,
        });
      }
    }
    input = [...input, ...localCalls.map(echoCall), ...outputs];
  }
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
