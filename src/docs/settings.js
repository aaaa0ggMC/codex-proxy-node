// How large an image may be before it is handed to the model. This is the user's call, not the
// tool's: a bigger ceiling sees more detail and costs proportionally more tokens and bandwidth,
// since the bytes are re-sent with every turn of a conversation.
const DEFAULT_MAX_EDGE = 1100;
const MIN_EDGE = 256;
const MAX_EDGE = 4096;

let maxEdge = DEFAULT_MAX_EDGE;

export function setImageMaxEdge(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_EDGE || parsed > MAX_EDGE) {
    throw new Error(`--image-max-edge must be an integer between ${MIN_EDGE} and ${MAX_EDGE}`);
  }
  maxEdge = parsed;
  return maxEdge;
}

export function imageMaxEdge() {
  return maxEdge;
}

export { DEFAULT_MAX_EDGE, MIN_EDGE, MAX_EDGE };

// Office rendering (LibreOffice WASM) is slow enough that it is behind a switch: production leaves
// it on, tests turn it off so a fixture never pays a minute of conversion.
let officeConverter = true;

export function setOfficeConverter(enabled) {
  officeConverter = enabled === true;
  return officeConverter;
}

export function officeConverterEnabled() {
  return officeConverter;
}
