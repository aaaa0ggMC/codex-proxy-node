// A small slog-style text logger: `time=... level=INFO msg="..." key=value`. Keeping it
// dependency-free matches the Go binary's output closely enough for MCPHub and for eyeballing.

function formatValue(value) {
  if (typeof value === "string") {
    return /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);
  }
  return String(value);
}

function createLogger(stream, base) {
  const emit = (level, message, fields) => {
    const parts = [
      `time=${new Date().toISOString()}`,
      `level=${level.toUpperCase()}`,
      `msg=${formatValue(message)}`,
    ];
    for (const [key, value] of Object.entries({ ...base, ...fields })) {
      if (value !== undefined) parts.push(`${key}=${formatValue(value)}`);
    }
    stream.write(parts.join(" ") + "\n");
  };

  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger(stream, { ...base, ...fields }),
  };
}

export function createLoggerTo(stream = process.stderr) {
  return createLogger(stream, {});
}
