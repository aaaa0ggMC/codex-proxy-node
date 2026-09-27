import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { Server } from "../src/server.js";
import { CodexProvider } from "../src/providers/codex.js";
import { createLoggerTo } from "../src/log.js";
import { silentLog, startHttpServer, withEndpoints } from "../test-support/helpers.js";
import { ToolRegistry } from "../src/agent/tools.js";

const usagePayload = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1789536659 },
    secondary_window: { used_percent: 94, limit_window_seconds: 604800, reset_at: 1789837677 },
  },
};

function textEvents(text) {
  return [
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.output_item.done",
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        model: "gpt-5.5",
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    },
  ];
}

function writeSSE(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

async function fakeUpstream({ events = textEvents("pong") } = {}) {
  const state = { responses: [], usageFails: false, usageCalls: 0, modelsCalls: 0 };
  const server = await startHttpServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/responses" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        state.responses.push(JSON.parse(body));
        writeSSE(res, events);
      });
      return;
    }
    if (url.pathname === "/models") {
      state.modelsCalls += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            { slug: "gpt-5.5", supported_in_api: true, visibility: "list" },
            { slug: "gpt-6-astra", supported_in_api: true, visibility: "list" },
            { slug: "hidden", supported_in_api: true, visibility: "hidden" },
          ],
        }),
      );
      return;
    }
    if (url.pathname === "/usage") {
      state.usageCalls += 1;
      if (state.usageFails) {
        res.writeHead(500);
        res.end("boom");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(usagePayload));
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  return { ...server, state };
}

async function startProxy({ usageTTL = 60, apiKey = "" } = {}) {
  const provider = new CodexProvider({
    tokens: { token: async () => ({ accessToken: "tok", accountId: "acct-1" }) },
  });
  const server = new Server({ provider, log: silentLog, apiKey, usageTTL });
  const proxy = await startHttpServer(server.handler());
  return { ...proxy, server };
}

async function chat(base, payload, headers = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

test("healthz answers without touching the upstream", async () => {
  const proxy = await startProxy();
  try {
    const resp = await fetch(`${proxy.base}/healthz`);
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true });
  } finally {
    await proxy.close();
  }
});

test("models lists the -search aliases so saved histories keep resolving", async () => {
  const upstream = await fakeUpstream();
  const proxy = await startProxy();
  try {
    const ids = await withEndpoints({ codexBaseURL: upstream.base }, async () => {
      const resp = await fetch(`${proxy.base}/v1/models`);
      assert.equal(resp.status, 200);
      const body = await resp.json();
      return body.data.map((m) => m.id);
    });
    for (const id of ["gpt-5.5", "gpt-5.5-search", "gpt-5.5-search-preview", "gpt-4o-search-preview"]) {
      assert.ok(ids.includes(id), `expected ${id} in ${ids.join(", ")}`);
    }
    assert.ok(!ids.includes("hidden"));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("chat completions forwards an image to the Codex backend", async () => {
  const upstream = await fakeUpstream();
  const proxy = await startProxy();
  try {
    const body = await withEndpoints({ codexBaseURL: upstream.base }, async () => {
      const resp = await chat(proxy.base, {
        model: "gpt-5.5",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } },
            ],
          },
        ],
      });
      assert.equal(resp.status, 200);
      return resp.json();
    });

    assert.equal(body.choices[0].message.content, "pong");
    const sent = upstream.state.responses.at(-1);
    assert.equal(sent.stream, true, "the upstream request must always stream");
    assert.deepEqual(sent.input[0].content[1], {
      type: "input_image",
      image_url: "data:image/png;base64,AAAA",
      detail: "high",
    });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("chat completions streams OpenAI chunks", async () => {
  const upstream = await fakeUpstream();
  const proxy = await startProxy();
  try {
    const text = await withEndpoints({ codexBaseURL: upstream.base }, async () => {
      const resp = await chat(proxy.base, {
        model: "gpt-5.5",
        stream: true,
        messages: [{ role: "user", content: "ping" }],
      });
      assert.match(resp.headers.get("content-type"), /text\/event-stream/);
      return resp.text();
    });

    assert.match(text, /"object":"chat\.completion\.chunk"/);
    assert.ok(text.includes('"content":"pong"'));
    assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("chat completions reports a tool call", async () => {
  const upstream = await fakeUpstream({
    events: [
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
      },
      {
        type: "response.completed",
        response: { id: "resp_t", status: "completed", model: "gpt-5.5", usage: {} },
      },
    ],
  });
  const proxy = await startProxy();
  try {
    const text = await withEndpoints({ codexBaseURL: upstream.base }, async () => {
      const resp = await chat(proxy.base, {
        model: "gpt-5.5",
        stream: true,
        messages: [{ role: "user", content: "ping" }],
      });
      return resp.text();
    });
    assert.ok(text.includes('"name":"lookup"'));
    assert.ok(text.includes('"finish_reason":"tool_calls"'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("chat completions rejects an unsupported attachment with a clear error", async () => {
  const proxy = await startProxy();
  try {
    const resp = await chat(proxy.base, {
      model: "gpt-5.5",
      messages: [
        { role: "user", content: [{ type: "file", file: { filename: "notes.pdf" } }] },
      ],
    });
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.match(body.error.message, /unsupported message content type "file"/);
  } finally {
    await proxy.close();
  }
});

test("responses aggregates a non-streaming answer", async () => {
  const upstream = await fakeUpstream({ events: textEvents("pong") });
  const proxy = await startProxy();
  try {
    const body = await withEndpoints({ codexBaseURL: upstream.base }, async () => {
      const resp = await fetch(`${proxy.base}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "ping" }),
      });
      assert.equal(resp.status, 200);
      return resp.json();
    });
    assert.equal(body.object, "response");
    assert.equal(body.id, "resp_test");
    assert.equal(body.output_text, undefined, "the internal accumulator must not leak");
    assert.equal(body.output[0].content[0].text, "pong");
    assert.equal(body.usage.total_tokens, 7);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("usage serves json, text and number formats", async () => {
  const upstream = await fakeUpstream();
  const proxy = await startProxy();
  try {
    await withEndpoints({ usageURL: `${upstream.base}/usage` }, async () => {
      const json = await (await fetch(`${proxy.base}/v1/usage`)).json();
      assert.equal(json.windows.five_hour.remaining_percent, 88);
      assert.equal(json.five_hour_remaining_percent, 88);
      assert.equal(json.remaining_percent, 6);

      const text = await (await fetch(`${proxy.base}/v1/usage?format=text`)).text();
      assert.equal(text.trim(), "5h 88% · 7d 6%");

      const number = await (await fetch(`${proxy.base}/v1/usage?format=number&window=five_hour`)).text();
      assert.equal(number.trim(), "88");

      const bad = await fetch(`${proxy.base}/v1/usage?format=yaml`);
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error.message, /unsupported format/);

      const missing = await fetch(`${proxy.base}/v1/usage?format=number&window=monthly`);
      assert.equal(missing.status, 502);
      assert.match((await missing.json()).error.message, /no usage window matches/);
    });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("usage serves the last known report when the backend fails", async () => {
  const upstream = await fakeUpstream();
  const proxy = await startProxy({ usageTTL: 0 });
  try {
    await withEndpoints({ usageURL: `${upstream.base}/usage` }, async () => {
      const fresh = await (await fetch(`${proxy.base}/v1/usage`)).json();
      assert.equal(fresh.stale, undefined);

      upstream.state.usageFails = true;
      const resp = await fetch(`${proxy.base}/v1/usage`);
      assert.equal(resp.status, 200);
      const stale = await resp.json();
      assert.equal(stale.stale, true);
      assert.equal(stale.windows.five_hour.used_percent, 12);
    });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("usage reports the upstream failure when there is no cache", async () => {
  const upstream = await fakeUpstream();
  upstream.state.usageFails = true;
  const proxy = await startProxy();
  try {
    await withEndpoints({ usageURL: `${upstream.base}/usage` }, async () => {
      const resp = await fetch(`${proxy.base}/v1/usage`);
      assert.equal(resp.status, 502);
      assert.match((await resp.json()).error.message, /HTTP 500/);
    });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("usage headers are attached without an extra fetch", async () => {
  const upstream = await fakeUpstream();
  const proxy = await startProxy();
  try {
    await withEndpoints({ usageURL: `${upstream.base}/usage` }, async () => {
      await fetch(`${proxy.base}/v1/usage`);
      const calls = upstream.state.usageCalls;

      const resp = await fetch(`${proxy.base}/healthz`);
      assert.equal(resp.headers.get("x-codex-usage-remaining"), "6");
      assert.equal(resp.headers.get("x-codex-usage-5h"), "88");
      assert.equal(resp.headers.get("x-codex-usage-weekly"), "6");
      assert.equal(upstream.state.usageCalls, calls, "headers must come from the cache");
    });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("a configured API key is enforced", async () => {
  const proxy = await startProxy({ apiKey: "secret" });
  try {
    const unauthorized = await fetch(`${proxy.base}/healthz`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("www-authenticate"), 'Bearer realm="codex-proxy"');

    const authorized = await fetch(`${proxy.base}/healthz`, {
      headers: { Authorization: "Bearer secret" },
    });
    assert.equal(authorized.status, 200);

    const wrong = await fetch(`${proxy.base}/healthz`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
  } finally {
    await proxy.close();
  }
});

test("the request log reports the bytes actually written", async () => {
  const lines = [];
  const log = createLoggerTo(
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    }),
  );
  const provider = new CodexProvider({
    tokens: { token: async () => ({ accessToken: "tok", accountId: "acct-1" }) },
  });
  const server = new Server({ provider, log, usageTTL: 60 });
  const proxy = await startHttpServer(server.handler());
  try {
    await fetch(`${proxy.base}/healthz`);
    const finished = lines.find((line) => line.includes("request finished"));
    assert.ok(finished, `expected a finished log line in ${lines.join("")}`);
    assert.match(finished, /status=200 bytes=11/, `unexpected log line: ${finished}`);
  } finally {
    await proxy.close();
  }
});

test("a slow local tool keeps the stream alive and can report progress", async () => {
  const upstream = await fakeUpstream({
    events: [
      {
        type: "response.output_item.done",
        data: { item: { type: "function_call", call_id: "c1", name: "docs__slow", arguments: "{}" } },
      },
      { type: "response.completed", data: { response: { id: "r1", status: "completed" } } },
      { type: "response.output_text.delta", data: { delta: "done" } },
      { type: "response.completed", data: { response: { id: "r2", status: "completed" } } },
    ],
  });
  // Two turns: the tool call, then the answer. fakeUpstream replays one list, so drive it directly.
  let turn = 0;
  const scripted = {
    async *events(request, signal) {
      const list =
        turn++ === 0
          ? upstream.state.responses.length >= 0 && [
              {
                type: "response.output_item.done",
                data: { item: { type: "function_call", call_id: "c1", name: "docs__slow", arguments: "{}" } },
              },
              { type: "response.completed", data: { response: { id: "r1", status: "completed" } } },
            ]
          : [
              { type: "response.output_text.delta", data: { delta: "done" } },
              { type: "response.completed", data: { response: { id: "r2", status: "completed" } } },
            ];
      for (const event of list) yield event;
    },
    async models() {
      return [];
    },
    async usage() {
      return null;
    },
  };

  const registry = new ToolRegistry().register({
    name: "docs",
    namespace: true,
    tools: [
      {
        name: "slow",
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          return "page text";
        },
      },
    ],
  });
  const proxy = await startHttpServer(
    new Server({ provider: scripted, log: silentLog, usageTTL: 60, registry, keepaliveMs: 40, progress: true }).handler(),
  );

  try {
    const resp = await chat(proxy.base, {
      model: "gpt-5.5",
      stream: true,
      messages: [{ role: "user", content: "read it" }],
    });
    const text = await resp.text();
    assert.match(text, /keepalive/, "the socket must stay busy while a local tool runs");
    assert.match(text, /<ignore>/, "progress rides the reasoning channel, tagged for removal");
    assert.match(text, /docs__slow/);
    assert.ok(text.trimEnd().endsWith("data: [DONE]"));
    assert.ok(!text.includes('"tool_calls"'), "the local tool call must stay hidden");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("model reasoning and progress share one folded <th> block", async () => {
  const provider = {
    async *events() {
      yield { type: "response.reasoning_summary_text.delta", data: { delta: "weighing options. " } };
      yield { type: "codex_proxy.tool_start", data: { name: "docs__open", arguments: '{"path":"/tmp/a.pptx"}' } };
      yield { type: "response.reasoning_summary_text.delta", data: { delta: "now reading." } };
      yield { type: "response.output_text.delta", data: { delta: "the answer" } };
      yield { type: "response.completed", data: { response: { id: "r", status: "completed" } } };
    },
    async models() {
      return [];
    },
    async usage() {
      return null;
    },
  };
  const proxy = await startHttpServer(new Server({ provider, log: silentLog, usageTTL: 60 }).handler());

  try {
    const text = await (await chat(proxy.base, {
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "read it" }],
    })).text();

    const deltas = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)))
      .map((chunk) => chunk.choices?.[0]?.delta ?? {});

    const reasoning = deltas.map((d) => d.reasoning_content ?? "").join("");
    assert.equal(
      reasoning,
      '<th><mth>weighing options. <ignore>docs__open(path=/tmp/a.pptx)</ignore>now reading.</mth></th>',
    );
    assert.equal(deltas.map((d) => d.content ?? "").join(""), "the answer");
    assert.ok(!/answer/.test(reasoning), "the answer must not leak into the thinking block");
  } finally {
    await proxy.close();
  }
});
