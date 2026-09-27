import { boolValue, defaultedString, stableId, stringValue } from "./util.js";
import { stripNotes, stripWrapper } from "./notes.js";
import {
  newOpenAIResponse,
  openAIOutputItem,
  outputTextFromItems,
  synthesizedMessageItem,
} from "./schema.js";

export const defaultInstructions = "You are a helpful assistant.";

// NormalizeResponsesRequest fills in what the Codex backend requires (streaming, store=false)
// and rejects what it cannot represent, so a caller gets a clear error instead of a silent
// behaviour change.
export function normalizeResponsesRequest(raw, { webSearch = false, searchAliases = false } = {}) {
  const model = stringValue(raw, "model");
  if (model === "") throw new Error("missing required field: model");
  const { upstreamModel, modelWantsSearch } = resolveModel(model, searchAliases);

  if (!("input" in raw)) throw new Error("missing required field: input");
  const normalizedInput = normalizeResponsesInput(raw.input);

  const out = {
    model: upstreamModel,
    input: normalizedInput,
    instructions: defaultedString(raw, "instructions", defaultInstructions),
    store: false,
    stream: true,
  };
  for (const key of ["reasoning", "text", "parallel_tool_calls"]) {
    if (key in raw) out[key] = raw[key];
  }

  const { intent, options } = extractWebSearchIntent(raw, webSearch, modelWantsSearch);

  let tools = [];
  if (Array.isArray(raw.tools)) {
    for (const item of raw.tools) {
      if (item != null && typeof item === "object") {
        const type = stringValue(item, "type");
        if (type === "web_search" || type === "web_search_preview") {
          tools.push(normalizeWebSearchTool(item));
          continue;
        }
      }
      tools.push(item);
    }
  }
  if (intent) tools = mergeWebSearchTool(tools, options);
  if (tools.length > 0) out.tools = tools;

  if ("tool_choice" in raw) {
    const tc = raw.tool_choice;
    if (tc != null && typeof tc === "object" && !Array.isArray(tc) && stringValue(tc, "type") === "web_search_preview") {
      out.tool_choice = { ...tc, type: "web_search" };
    } else {
      out.tool_choice = tc;
    }
  }

  return { request: out, stream: boolValue(raw, "stream") };
}

export function normalizeResponsesInput(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (Array.isArray(input)) return input;
  if (input != null && typeof input === "object") return [input];
  throw new Error("input must be a string, object, or array");
}

export function buildResponsesRequestFromChat(raw, { webSearch = false, searchAliases = false } = {}) {
  const model = stringValue(raw, "model");
  if (model === "") throw new Error("missing required field: model");
  const { upstreamModel, modelWantsSearch } = resolveModel(model, searchAliases);

  const messages = raw.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("missing required field: messages");
  }

  const instructions = [];
  const input = [];
  for (const item of messages) {
    if (item == null || typeof item !== "object") {
      throw new Error("messages must contain objects");
    }
    const role = stringValue(item, "role");
    switch (role) {
      case "system":
      case "developer": {
        const text = chatContentText(item.content);
        if (text !== "") instructions.push(text);
        break;
      }
      case "user":
        input.push({ role: "user", content: chatMessageContent(item.content) });
        break;
      case "assistant": {
        // Providers with thinking mode require their reasoning back verbatim on the next turn
        // (DeepSeek answers 400 otherwise), so it is replayed as a reasoning item with our own
        // wrapper and bookkeeping removed.
        const reasoning = stripWrapper(stringValue(item, "reasoning_content"));
        if (reasoning !== "") {
          input.push({ type: "reasoning", content: [{ type: "reasoning_text", text: reasoning }] });
        }
        const text = stripNotes(chatContentText(item.content));
        if (text !== "") input.push({ role: "assistant", content: text });
        if (Array.isArray(item.tool_calls)) {
          for (const [index, toolCall] of item.tool_calls.entries()) {
            const call = responsesFunctionCallFromChat(toolCall, index);
            if (call != null) input.push(call);
          }
        }
        break;
      }
      case "tool": {
        const callId = stringValue(item, "tool_call_id");
        if (callId === "") throw new Error("tool message is missing tool_call_id");
        input.push({
          type: "function_call_output",
          call_id: callId,
          output: chatToolOutput(item.content),
        });
        break;
      }
      default:
        throw new Error(`unsupported message role ${JSON.stringify(role)}`);
    }
  }
  if (input.length === 0) input.push({ role: "user", content: "" });

  const out = {
    model: upstreamModel,
    input,
    instructions: defaultInstructions,
    store: false,
    stream: true,
  };
  if (instructions.length > 0) out.instructions = instructions.join("\n\n");

  const { intent, options } = extractWebSearchIntent(raw, webSearch, modelWantsSearch);

  let tools = responsesToolsFromChat(raw.tools);
  if (intent) tools = mergeWebSearchTool(tools, options);
  if (tools.length > 0) out.tools = tools;

  const toolChoice = responsesToolChoiceFromChat(raw.tool_choice);
  if (toolChoice.ok) out.tool_choice = toolChoice.value;

  const text = responsesTextFromChatResponseFormat(raw.response_format);
  if (text.ok) out.text = text.value;

  if (typeof raw.parallel_tool_calls === "boolean") {
    out.parallel_tool_calls = raw.parallel_tool_calls;
  }
  if (raw.reasoning != null && typeof raw.reasoning === "object" && !Array.isArray(raw.reasoning)) {
    out.reasoning = raw.reasoning;
  } else {
    const effort = stringValue(raw, "reasoning_effort");
    if (effort !== "") out.reasoning = { effort };
  }

  return { request: out, stream: boolValue(raw, "stream") };
}

// aggregateResponsesStream folds a stream of Responses events into a single response object,
// which is what a non-streaming client asked for. It takes an event iterable rather than a body
// so the agent loop can sit between the provider and the aggregation.
export async function aggregateResponsesStream(events, upstream) {
  const agg = newOpenAIResponse(upstream);
  agg.outputText = "";

  for await (const event of events) {
    switch (event.type) {
      case "response.output_text.delta":
        agg.outputText += stringValue(event.data, "delta");
        break;
      case "response.output_item.done": {
        const item = event.data.item;
        if (item != null && typeof item === "object") agg.output.push(openAIOutputItem(item));
        break;
      }
      case "response.completed": {
        const response = event.data.response;
        if (response != null && typeof response === "object") {
          const id = stringValue(response, "id");
          if (id !== "") agg.id = id;
          const status = stringValue(response, "status");
          if (status !== "") agg.status = status;
          const model = stringValue(response, "model");
          if (model !== "") agg.model = model;
          if (response.usage != null) agg.usage = response.usage;
        }
        break;
      }
      case "response.failed":
      case "response.incomplete":
        agg.status = event.type.replace("response.", "");
        break;
      default:
        break;
    }
  }

  if (agg.output.length === 0 && agg.outputText !== "") {
    agg.output = [synthesizedMessageItem(agg.outputText)];
  }
  if (agg.outputText === "") agg.outputText = outputTextFromItems(agg.output);
  return agg;
}

export function chatContentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => item != null && typeof item === "object" && stringValue(item, "type") === "text")
      .map((item) => stringValue(item, "text"))
      .join("");
  }
  return JSON.stringify(content);
}

// chatMessageContent converts an OpenAI chat message's content into the shape the Codex
// Responses backend accepts. Plain strings pass through, while structured content becomes
// input_text, input_image and input_audio parts so images and audio are forwarded instead of
// being silently dropped.
export function chatMessageContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item == null || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("message content parts must be objects");
      }
      parts.push(responsesContentPart(item));
    }
    if (parts.length === 0) return "";
    return parts;
  }
  throw new Error(`unsupported message content ${JSON.stringify(content)}`);
}

// chatToolOutput converts a tool message's content into a function_call_output body. Text-only
// content stays a plain string, which is what almost every client sends; structured content
// becomes the array of input_text / input_image / input_audio parts the Codex backend accepts as
// a tool result, so a tool can hand images back instead of having them silently dropped.
export function chatToolOutput(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item == null || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("tool message content parts must be objects");
      }
      parts.push(responsesContentPart(item));
    }
    if (parts.length === 0) return "";
    return parts;
  }
  throw new Error(`unsupported tool message content ${JSON.stringify(content)}`);
}

// responsesContentPart maps one chat content part onto its Responses equivalent. The Codex
// backend understands input_text, input_image (image_url + detail) and input_audio (audio_url);
// anything else is rejected so a dropped attachment is never mistaken for an accepted one.
export function responsesContentPart(part) {
  switch (stringValue(part, "type").toLowerCase()) {
    case "":
    case "text":
    case "input_text":
      return { type: "input_text", text: stringValue(part, "text") };
    case "image_url":
    case "image":
    case "input_image": {
      const { url, detail } = imagePartURL(part);
      if (url === "") throw new Error("image content part is missing image_url");
      const out = { type: "input_image", image_url: url };
      if (detail !== "") out.detail = detail;
      return out;
    }
    case "input_audio":
    case "audio": {
      const url = audioPartURL(part);
      if (url === "") throw new Error("audio content part is missing audio data");
      return { type: "input_audio", audio_url: url };
    }
    default:
      throw new Error(
        `unsupported message content type ${JSON.stringify(stringValue(part, "type"))}: the Codex backend accepts text, images and audio`,
      );
  }
}

function imagePartURL(part) {
  let detail = stringValue(part, "detail");
  const imageURL = part.image_url;
  if (typeof imageURL === "string") return { url: imageURL, detail };
  if (imageURL != null && typeof imageURL === "object" && !Array.isArray(imageURL)) {
    if (stringValue(imageURL, "detail") !== "") detail = stringValue(imageURL, "detail");
    return { url: stringValue(imageURL, "url"), detail };
  }
  return { url: stringValue(part, "url"), detail };
}

function audioPartURL(part) {
  const direct = stringValue(part, "audio_url");
  if (direct !== "") return direct;
  for (const key of ["input_audio", "audio"]) {
    const nested = part[key];
    if (nested == null || typeof nested !== "object" || Array.isArray(nested)) continue;
    const audioURL = stringValue(nested, "audio_url") || stringValue(nested, "url");
    if (audioURL !== "") return audioURL;
    const data = stringValue(nested, "data");
    if (data !== "") {
      return "data:audio/" + defaultedString(nested, "format", "wav") + ";base64," + data;
    }
  }
  return "";
}

export function responsesFunctionCallFromChat(toolCall, index = 0) {
  if (toolCall == null || typeof toolCall !== "object" || stringValue(toolCall, "type") !== "function") {
    return null;
  }
  const fn = toolCall.function;
  if (fn == null || typeof fn !== "object") return null;
  const name = stringValue(fn, "name");
  if (name === "") return null;
  // A client that omits tool call ids would otherwise get a fresh random id on every request,
  // changing the prompt prefix each time. Derive it from the position and content instead.
  const callId = stringValue(toolCall, "id") || stableId("call", String(index), name, stringValue(fn, "arguments"));
  const args = stringValue(fn, "arguments") || "{}";
  return { type: "function_call", call_id: callId, name, arguments: args };
}

export function responsesToolChoiceFromChat(value) {
  if (value == null) return { value: null, ok: false };
  if (typeof value === "string") {
    if (value === "auto" || value === "none" || value === "required") return { value, ok: true };
    throw new Error(`unsupported tool_choice ${JSON.stringify(value)}`);
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool_choice must be a string or object");
  }
  switch (stringValue(value, "type")) {
    case "function": {
      let name = stringValue(value, "name");
      if (name === "") name = stringValue(value.function ?? {}, "name");
      if (name === "") throw new Error("function tool_choice is missing a function name");
      return { value: { type: "function", name }, ok: true };
    }
    case "web_search":
    case "web_search_preview":
      return { value: { type: "web_search" }, ok: true };
    default:
      throw new Error(`unsupported tool_choice type ${JSON.stringify(stringValue(value, "type"))}`);
  }
}

export function responsesTextFromChatResponseFormat(value) {
  if (value == null) return { value: null, ok: false };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("response_format must be an object");
  }
  const type = stringValue(value, "type");
  if (type === "text" || type === "json_object") {
    return { value: { format: { type } }, ok: true };
  }
  if (type === "json_schema") {
    const jsonSchema = value.json_schema ?? {};
    const format = { type: "json_schema" };
    for (const key of ["name", "description", "schema", "strict"]) {
      if (key in jsonSchema) format[key] = jsonSchema[key];
    }
    if (stringValue(format, "name") === "") {
      throw new Error("response_format.json_schema is missing name");
    }
    if (!("schema" in format)) throw new Error("response_format.json_schema is missing schema");
    return { value: { format }, ok: true };
  }
  throw new Error(`unsupported response_format type ${JSON.stringify(type)}`);
}

export function responsesToolsFromChat(value) {
  if (!Array.isArray(value)) return [];
  const tools = [];
  for (const item of value) {
    if (item == null || typeof item !== "object") continue;
    switch (stringValue(item, "type")) {
      case "function": {
        const fn = item.function;
        if (fn == null || typeof fn !== "object" || stringValue(fn, "name") === "") continue;
        const tool = {
          type: "function",
          name: stringValue(fn, "name"),
          description: stringValue(fn, "description"),
          parameters: { type: "object", properties: {} },
        };
        if ("parameters" in fn) tool.parameters = fn.parameters;
        if (typeof fn.strict === "boolean") tool.strict = fn.strict;
        tools.push(tool);
        break;
      }
      case "web_search":
      case "web_search_preview":
        tools.push(normalizeWebSearchTool(item));
        break;
      default:
        break;
    }
  }
  return tools;
}

// resolveModel maps a requested model id onto the upstream model. The -search / -search-preview
// suffixes are kept as compatibility aliases because clients (Rikkahub among them) have those
// ids saved per conversation, but they are pure aliases: they select the same model and do not
// enable web search on their own. Search is a software feature, driven by web_search_options,
// tools, tool_choice or --web-search.
export function resolveModel(model, searchAliases = false) {
  const lower = model.toLowerCase();
  for (const suffix of ["-search-preview", "-search"]) {
    if (lower.endsWith(suffix)) {
      return { upstreamModel: mapBaseModel(model.slice(0, -suffix.length)), modelWantsSearch: searchAliases };
    }
  }
  return { upstreamModel: model, modelWantsSearch: false };
}

export function mapBaseModel(base) {
  const lower = base.toLowerCase();
  if (lower === "gpt-4o" || lower === "gpt-4o-mini") return "gpt-5.5";
  return base;
}

export function normalizeWebSearchTool(m) {
  const tool = { type: "web_search" };
  const copyOption = (src, key) => {
    if (src != null && src[key] != null) tool[key] = src[key];
  };
  const options = ["search_context_size", "user_location", "return_token_budget", "search_content_types"];
  for (const key of options) copyOption(m, key);
  for (const subKey of ["web_search", "web_search_preview"]) {
    const sub = m?.[subKey];
    if (sub != null && typeof sub === "object" && !Array.isArray(sub)) {
      for (const key of options) copyOption(sub, key);
    }
  }
  const loc = tool.user_location;
  if (loc != null && typeof loc === "object" && !Array.isArray(loc) && stringValue(loc, "type") === "") {
    loc.type = "approximate";
  }
  return tool;
}

export function extractWebSearchIntent(raw, defaultWebSearch) {
  if (typeof raw.web_search_options === "boolean" && !raw.web_search_options) {
    return { intent: false, options: {} };
  }

  const options = {};
  let intent = defaultWebSearch;

  const wsOptions = raw.web_search_options;
  if (wsOptions != null && typeof wsOptions === "object" && !Array.isArray(wsOptions)) {
    intent = true;
    Object.assign(options, wsOptions);
  } else if (wsOptions === true) {
    intent = true;
  }

  const tc = raw.tool_choice;
  if (tc != null && typeof tc === "object" && !Array.isArray(tc)) {
    const type = stringValue(tc, "type");
    if (type === "web_search" || type === "web_search_preview") intent = true;
  }

  const keys = ["search_context_size", "user_location", "return_token_budget", "search_content_types"];
  if (Array.isArray(raw.tools)) {
    for (const item of raw.tools) {
      if (item == null || typeof item !== "object") continue;
      const type = stringValue(item, "type");
      if (type !== "web_search" && type !== "web_search_preview") continue;
      intent = true;
      for (const key of keys) {
        if (item[key] != null) options[key] = item[key];
      }
      for (const subKey of ["web_search", "web_search_preview"]) {
        const sub = item[subKey];
        if (sub == null || typeof sub !== "object" || Array.isArray(sub)) continue;
        for (const key of keys) {
          if (sub[key] != null) options[key] = sub[key];
        }
      }
    }
  }

  return { intent, options };
}

export function hasWebSearchTool(tools) {
  return tools.some((item) => item != null && typeof item === "object" && stringValue(item, "type") === "web_search");
}

export function mergeWebSearchTool(tools, searchOptions) {
  let found = false;
  for (let i = 0; i < tools.length; i++) {
    const item = tools[i];
    if (item != null && typeof item === "object" && stringValue(item, "type") === "web_search") {
      found = true;
      tools[i] = mergeSearchOptions(item, searchOptions);
      break;
    }
  }
  if (!found) tools.push(normalizeWebSearchTool(searchOptions));
  return tools;
}

function mergeSearchOptions(existing, searchOptions) {
  const out = { ...existing };
  for (const key of ["search_context_size", "user_location", "return_token_budget", "search_content_types"]) {
    const value = searchOptions[key];
    if (value != null && !(key in out)) out[key] = value;
  }
  return normalizeWebSearchTool(out);
}
