import { stringValue } from "../util.js";

// The bridge between the two wire formats. The proxy's canonical format is the Responses API,
// because that is the richer one; a provider that only speaks Chat Completions gets requests
// translated down and streams translated back up here.

function textFromParts(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part != null && typeof part === "object" && stringValue(part, "type") === "input_text")
    .map((part) => stringValue(part, "text"))
    .join("");
}

// responsesContentToChatContent keeps a plain string when everything is text (the shape every
// provider understands) and only builds a part array when there is an image to carry.
export function responsesContentToChatContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (part == null || typeof part !== "object") continue;
    switch (stringValue(part, "type")) {
      case "input_text":
        parts.push({ type: "text", text: stringValue(part, "text") });
        break;
      case "input_image": {
        const image = { url: stringValue(part, "image_url") };
        const detail = stringValue(part, "detail");
        if (detail !== "") image.detail = detail;
        parts.push({ type: "image_url", image_url: image });
        break;
      }
      default:
        break;
    }
  }
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("");
  }
  return parts;
}

export function responsesToolsToChatTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    if (tool == null || typeof tool !== "object" || stringValue(tool, "type") !== "function") continue;
    if (stringValue(tool, "name") === "") continue;
    const fn = {
      name: stringValue(tool, "name"),
      description: stringValue(tool, "description"),
      parameters: tool.parameters ?? { type: "object", properties: {} },
    };
    out.push({ type: "function", function: fn });
  }
  return out;
}

export function responsesToolChoiceToChatToolChoice(choice) {
  if (choice == null) return undefined;
  if (typeof choice === "string") return choice;
  if (typeof choice !== "object") return undefined;
  if (stringValue(choice, "type") === "function") {
    const name = stringValue(choice, "name");
    return name === "" ? undefined : { type: "function", function: { name } };
  }
  return undefined;
}

// toChatRequest flattens canonical Responses input into a Chat Completions request. Consecutive
// assistant text and tool calls are merged into one assistant message, because that is how the
// chat format models "the model said this and asked for that".
export function toChatRequest(request, { model, reasoningEffort } = {}) {
  const messages = [];
  const instructions = stringValue(request, "instructions");
  if (instructions !== "") messages.push({ role: "system", content: instructions });

  let pending = null;
  const flush = () => {
    if (pending != null && (pending.content != null || (pending.tool_calls ?? []).length > 0)) {
      messages.push(pending);
    }
    pending = null;
  };

  for (const item of Array.isArray(request.input) ? request.input : []) {
    if (item == null || typeof item !== "object") continue;
    const type = stringValue(item, "type");

    if (type === "function_call") {
      pending ??= { role: "assistant", content: null };
      pending.tool_calls ??= [];
      pending.tool_calls.push({
        id: stringValue(item, "call_id") || stringValue(item, "id"),
        type: "function",
        function: { name: stringValue(item, "name"), arguments: stringValue(item, "arguments") || "{}" },
      });
      continue;
    }
    if (type === "function_call_output") {
      flush();
      messages.push({
        role: "tool",
        tool_call_id: stringValue(item, "call_id"),
        content: responsesContentToChatContent(item.output),
      });
      continue;
    }
    if (type === "message" || stringValue(item, "role") !== "") {
      const role = stringValue(item, "role");
      if (role === "assistant") {
        pending ??= { role: "assistant", content: null };
        const text = textFromParts(item.content);
        if (text !== "") pending.content = (pending.content ?? "") + text;
        continue;
      }
      flush();
      messages.push({
        role: role === "developer" ? "system" : role || "user",
        content: responsesContentToChatContent(item.content),
      });
    }
  }
  flush();

  const out = { model, messages, stream: true };
  const tools = responsesToolsToChatTools(request.tools);
  if (tools.length > 0) out.tools = tools;
  const toolChoice = responsesToolChoiceToChatToolChoice(request.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (typeof request.parallel_tool_calls === "boolean") out.parallel_tool_calls = request.parallel_tool_calls;

  const format = request.text?.format;
  if (format != null && typeof format === "object") {
    const fmtType = stringValue(format, "type");
    if (fmtType === "json_object") out.response_format = { type: "json_object" };
    else if (fmtType === "json_schema") {
      out.response_format = { type: "json_schema", json_schema: { name: stringValue(format, "name") } };
      if (format.schema != null) out.response_format.json_schema.schema = format.schema;
      if (typeof format.strict === "boolean") out.response_format.json_schema.strict = format.strict;
    }
  }

  const effort = reasoningEffort ?? stringValue(request.reasoning, "effort");
  if (effort !== "") out.reasoning_effort = effort;
  return out;
}

export function chatUsageToResponsesUsage(usage) {
  if (usage == null) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
    input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
  };
}

export function chatModelsToCodexModels(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data
    .map((model) => (typeof model === "string" ? model : stringValue(model, "id")))
    .filter((id) => id !== "")
    .map((id) => ({ slug: id, supported_in_api: true, visibility: "list" }));
}

// chatStreamToResponses replays a Chat Completions SSE stream as Responses events, so both
// transports behave identically no matter which provider is behind them.
export async function* chatStreamToResponses(events, { id, model }) {
  let text = "";
  const toolCalls = new Map();
  let usage = null;

  for await (const event of events) {
    const chunk = event.data;
    if (chunk?.usage != null) usage = chunk.usage;
    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null;
    if (choice == null) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.content === "string" && delta.content !== "") {
      text += delta.content;
      yield { type: "response.output_text.delta", data: { type: "response.output_text.delta", delta: delta.content } };
    }
    // Reasoning-capable chat models put their thinking in a field whose name is not standardised:
    // DeepSeek uses reasoning_content, StepFun uses reasoning. Both are carried as a reasoning event
    // so the transport can decide how to present them.
    const thinking = typeof delta.reasoning_content === "string" ? delta.reasoning_content : delta.reasoning;
    if (typeof thinking === "string" && thinking !== "") {
      yield {
        type: "response.reasoning_summary_text.delta",
        data: { type: "response.reasoning_summary_text.delta", delta: thinking },
      };
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = typeof call.index === "number" ? call.index : 0;
      const entry = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (call.id) entry.id = call.id;
      if (call.function?.name) entry.name = call.function.name;
      if (call.function?.arguments) entry.arguments += call.function.arguments;
      toolCalls.set(index, entry);
    }
  }

  for (const [index, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    yield {
      type: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: `fc_${index}`,
          call_id: call.id || `call_${index}`,
          name: call.name,
          arguments: call.arguments || "{}",
        },
      },
    };
  }
  if (text !== "") {
    yield {
      type: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      },
    };
  }
  yield {
    type: "response.completed",
    data: {
      type: "response.completed",
      response: { id, status: "completed", model, usage: chatUsageToResponsesUsage(usage) },
    },
  };
}
