import { numberOrZero, randomHex, stringValue, defaultedString } from "./util.js";

// OpenAI-compatible response shapes live here so endpoint schemas are easy to audit.
// Field sets are based on https://github.com/openai/openai-openapi.

// openAIModelsResponse lists the models an account can actually use. Web search is a software
// feature here (web_search_options / tools / --web-search), so -search suffixes are plain aliases
// of a base model rather than separate models.
//
// Only providers that ask for them get those aliases (Codex does, because clients such as
// Rikkahub have ids like `<model>-search-preview` saved per conversation and dropping the id would
// blank out existing history). Every other provider is listed once, under its real id.
export function openAIModelsResponse(models) {
  const data = [];
  let anyAliases = false;
  for (const model of models) {
    if (!model?.supported_in_api || model.visibility !== "list") continue;
    const aliases = model.search_aliases === true;
    if (aliases) anyAliases = true;
    for (const suffix of aliases ? ["", "-search", "-search-preview"] : [""]) {
      data.push({
        id: model.slug + suffix,
        object: "model",
        created: 0,
        owned_by: model.owned_by ?? "openai-codex",
      });
    }
  }
  if (anyAliases) {
    // Compatibility alias for clients that hardcode this id.
    data.push({ id: "gpt-4o-search-preview", object: "model", created: 0, owned_by: "openai-codex" });
  }
  return { object: "list", data };
}

export function openAIErrorResponse(message) {
  return {
    error: {
      message,
      type: "invalid_request_error",
      param: null,
      code: null,
    },
  };
}

export function newOpenAIResponse(upstream) {
  const instructions = upstream.instructions ?? null;
  const reasoning = upstream.reasoning ?? { effort: null, summary: null };
  const text = upstream.text ?? { format: { type: "text" } };
  const tools = Array.isArray(upstream.tools) ? upstream.tools : [];
  const toolChoice = upstream.tool_choice ?? "auto";
  const metadata = upstream.metadata ?? {};
  const parallelToolCalls =
    typeof upstream.parallel_tool_calls === "boolean" ? upstream.parallel_tool_calls : true;

  return {
    id: "resp_" + randomHex(16),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions,
    max_output_tokens: upstream.max_output_tokens ?? null,
    model: stringValue(upstream, "model"),
    output: [],
    parallel_tool_calls: parallelToolCalls,
    previous_response_id: upstream.previous_response_id ?? null,
    reasoning,
    store: false,
    temperature: 1,
    text,
    tool_choice: toolChoice,
    tools,
    top_p: 1,
    truncation: "disabled",
    usage: openAIResponseUsage(null),
    user: upstream.user ?? null,
    metadata,
  };
}

export function openAIOutputItem(item) {
  switch (stringValue(item, "type")) {
    case "message":
      return openAIMessageItem(item);
    case "function_call":
      return openAIFunctionCallItem(item);
    default:
      return item;
  }
}

export function openAIMessageItem(item) {
  const content = [];
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part == null || typeof part !== "object" || stringValue(part, "type") !== "output_text") {
        continue;
      }
      content.push({
        type: "output_text",
        text: stringValue(part, "text"),
        annotations: Array.isArray(part.annotations) ? part.annotations : [],
        logprobs: Array.isArray(part.logprobs) ? part.logprobs : [],
      });
    }
  }
  return {
    id: defaultedString(item, "id", "msg_" + randomHex(16)),
    type: "message",
    status: defaultedString(item, "status", "completed"),
    role: defaultedString(item, "role", "assistant"),
    content,
  };
}

export function openAIFunctionCallItem(item) {
  let callId = stringValue(item, "call_id");
  if (callId === "") callId = defaultedString(item, "id", "call_" + randomHex(8));
  let args = stringValue(item, "arguments");
  if (args === "") args = "{}";
  return {
    id: defaultedString(item, "id", "fc_" + randomHex(16)),
    type: "function_call",
    status: defaultedString(item, "status", "completed"),
    call_id: callId,
    name: stringValue(item, "name"),
    arguments: args,
  };
}

export function synthesizedMessageItem(text) {
  return {
    id: "msg_" + randomHex(16),
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
  };
}

export function chatCompletionFromAggregate(agg, model) {
  const toolCalls = chatToolCallsFromOutput(agg.output);
  let finishReason = "stop";
  const message = {
    role: "assistant",
    content: agg.outputText,
    refusal: null,
    annotations: chatAnnotationsFromOutput(agg.output),
  };
  if (toolCalls.length > 0) {
    finishReason = "tool_calls";
    message.tool_calls = toolCalls;
    if (agg.outputText === "") message.content = null;
  }
  return {
    id: "chatcmpl-" + agg.id.replace(/^resp_/, ""),
    object: "chat.completion",
    created: agg.created_at,
    model,
    service_tier: "default",
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason }],
    usage: chatUsageFromResponsesUsage(agg.usage),
  };
}

export function openAIChatCompletionChunk(id, model, created, choices, usage) {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    service_tier: "default",
    choices,
  };
  if (usage != null) chunk.usage = usage;
  return chunk;
}

export function openAIChatDeltaChoice(delta, finishReason) {
  return { index: 0, delta, logprobs: null, finish_reason: finishReason };
}

export function openAIChatToolCallDelta(index, callId, name, args) {
  return {
    tool_calls: [
      { index, id: callId, type: "function", function: { name, arguments: args } },
    ],
  };
}

export function chatToolCallsFromOutput(output) {
  const toolCalls = [];
  for (const item of output) {
    if (item == null || typeof item !== "object" || stringValue(item, "type") !== "function_call") {
      continue;
    }
    let callId = stringValue(item, "call_id") || stringValue(item, "id");
    if (callId === "") callId = "call_" + randomHex(8);
    const args = stringValue(item, "arguments") || "{}";
    toolCalls.push({
      id: callId,
      type: "function",
      function: { name: stringValue(item, "name"), arguments: args },
    });
  }
  return toolCalls;
}

export function chatAnnotationsFromOutput(output) {
  const annotations = [];
  for (const item of output) {
    if (item == null || typeof item !== "object" || stringValue(item, "type") !== "message") {
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part != null && Array.isArray(part.annotations)) annotations.push(...part.annotations);
    }
  }
  return annotations;
}

export function outputTextFromItems(output) {
  let text = "";
  for (const item of output) {
    if (item == null || typeof item !== "object" || stringValue(item, "type") !== "message") {
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part != null && stringValue(part, "type") === "output_text") {
        text += stringValue(part, "text");
      }
    }
  }
  return text;
}

export function openAIResponseUsage(usage) {
  const m = usage ?? {};
  const inputDetails = m.input_tokens_details ?? {};
  const outputDetails = m.output_tokens_details ?? {};
  return {
    input_tokens: numberOrZero(m.input_tokens),
    output_tokens: numberOrZero(m.output_tokens),
    total_tokens: numberOrZero(m.total_tokens),
    input_tokens_details: { cached_tokens: numberOrZero(inputDetails.cached_tokens) },
    output_tokens_details: { reasoning_tokens: numberOrZero(outputDetails.reasoning_tokens) },
  };
}

export function chatUsageFromResponsesUsage(usage) {
  const m = usage ?? {};
  const promptDetails = m.input_tokens_details ?? {};
  const completionDetails = m.output_tokens_details ?? {};
  return {
    prompt_tokens: numberOrZero(m.input_tokens),
    completion_tokens: numberOrZero(m.output_tokens),
    total_tokens: numberOrZero(m.total_tokens),
    prompt_tokens_details: {
      cached_tokens: numberOrZero(promptDetails.cached_tokens),
      audio_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: numberOrZero(completionDetails.reasoning_tokens),
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  };
}
