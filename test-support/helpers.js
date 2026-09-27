import http from "node:http";
import { Writable } from "node:stream";
import { createLoggerTo } from "../src/log.js";

export function startHttpServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

export const silentLog = createLoggerTo(
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }),
);

// withEndpoints temporarily points upstream URLs at a local test server.
export async function withEndpoints(overrides, fn) {
  const { endpoints } = await import("../src/endpoints.js");
  const original = { ...endpoints };
  Object.assign(endpoints, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(endpoints, original);
  }
}
