import { test } from "node:test";
import assert from "node:assert/strict";
import { Server } from "../src/server.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { silentLog, startHttpServer } from "../test-support/helpers.js";
import { ImageRefRewriter, parseImageAlt } from "../src/images.js";
import { putImage } from "../src/media.js";
import imageDesign from "../plugins/image-design/index.js";

const provider = {
  async *events() {},
  async models() {
    return [];
  },
  async usage() {
    return null;
  },
};

test("parseImageAlt reads the visibility flag and defaults to invisible", () => {
  assert.deepEqual(parseImageAlt("cover|visible"), { alt: "cover", visible: true });
  assert.deepEqual(parseImageAlt("cover|invisible"), { alt: "cover", visible: false });
  assert.deepEqual(parseImageAlt("cover"), { alt: "cover", visible: false });
});

test("ImageRefRewriter resolves a reference split across chunks", () => {
  const rewriter = new ImageRefRewriter(({ alt, visible, src }) => `![${alt}|${visible}](${src})`);
  const out =
    rewriter.feed("see ![").text +
    rewriter.feed("cover|visible").text +
    rewriter.feed("](img_a) done").text +
    rewriter.flush().text;
  assert.equal(out, "see ![cover|true](img_a) done");
});

test("ImageRefRewriter leaves an unknown reference alone and passes ordinary text through", () => {
  const rewriter = new ImageRefRewriter(() => null);
  assert.equal(rewriter.feed("a ![x](y) b ! c").text + rewriter.flush().text, "a ![x](y) b ! c");
});

test("image-design turns base64 into a media URL and marks the disposition in the fragment", () => {
  const out = imageDesign.images.resolve(
    { alt: "cover", visible: true, src: "data:image/png;base64,QUJD" },
    { origin: "http://h:1" },
  );
  assert.match(out, /^!\[cover\]\(http:\/\/h:1\/media\/img_[a-f0-9]+#visible\)$/);
  assert.equal(imageDesign.images.resolve({ alt: "x", visible: false, src: "nonsense://y" }, {}), null);
});

test("image-design keeps visible images and labels invisible ones by what was delivered", () => {
  const text =
    "a ![x](http://h:1/media/img_ab#visible) "
    + "b ![y](http://cdn.example/z.png#invisible) "
    + "c ![z](img_ab12cd#invisible)";
  assert.equal(
    imageDesign.restoreText(text),
    "a ![x](http://h:1/media/img_ab#visible) "
    + "b [image link: y (http://cdn.example/z.png)] "
    + "c [sent image: z (img_ab12cd)]",
  );
});

test("a reference the outbound pass never rewrote is left exactly as the model wrote it", () => {
  assert.equal(imageDesign.restoreText("a ![y](z) b ![](image) c"), "a ![y](z) b ![](image) c");
});

// A `+ "…"` on its own line in an array literal is unary plus, which silently turns the prose into
// NaN; both strings are shown to people or the model, so a stray one must fail loudly here.
test("image-design's docs and instructions read as prose, without a stray NaN", () => {
  assert.ok(!imageDesign.docs.includes("NaN"), "the plugin page must not contain NaN");
  assert.ok(!imageDesign.instructions.includes("NaN"), "the model-facing instructions must not contain NaN");
});

test("an invisible receipt keeps the handle so the model knows the picture went out", () => {
  const handle = putImage(Buffer.from("IMG").toString("base64"), "image/png");
  assert.equal(
    imageDesign.restoreText(`here ![cover](http://h:1/media/${handle}#invisible)`),
    `here [sent image: cover (${handle})]`,
  );
  assert.equal(imageDesign.restoreText("here ![cover](img_ab12cd#invisible)"), "here [sent image: cover (img_ab12cd)]");
});

test("a visible image is re-attached to the model as a picture on replay", () => {
  const handle = putImage(Buffer.from("IMG").toString("base64"), "image/png");
  const visible = imageDesign.contribute({ input: [{ role: "assistant", content: `here ![c](http://h:1/media/${handle}#visible)` }] });
  assert.equal(visible.append[0].role, "developer");
  assert.ok(visible.append[0].content.some((part) => part.type === "input_image"), "the picture is handed back");

  const hidden = imageDesign.contribute({ input: [{ role: "assistant", content: `here ![c](http://h:1/media/${handle}#invisible)` }] });
  assert.equal(hidden, null, "an invisible image is not re-attached");
});

test("the proxy serves a stored image at /media/<id>", async () => {
  const id = putImage(Buffer.from("PNGDATA").toString("base64"), "image/png");
  const server = new Server({ provider, log: silentLog, usageTTL: 60, registry: new ToolRegistry() });
  const http = await startHttpServer(server.handler());
  try {
    const response = await fetch(`${http.base}/media/${id}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "PNGDATA");
    assert.equal((await fetch(`${http.base}/media/img_missing`)).status, 404);
  } finally {
    await http.close();
  }
});

test("a model's image reference reaches the client as a fetchable media URL", async () => {
  const handle = putImage(Buffer.from("IMG").toString("base64"), "image/png");
  const registry = new ToolRegistry().register(imageDesign);
  const streaming = {
    async *events() {
      yield { type: "response.output_text.delta", data: { delta: `Here: ![cover|invisible](${handle})` } };
      yield { type: "response.completed", data: { response: { id: "r", status: "completed", usage: {} } } };
    },
    async models() {
      return [];
    },
    async usage() {
      return null;
    },
  };
  const server = new Server({ provider: streaming, log: silentLog, usageTTL: 60, registry });
  const http = await startHttpServer(server.handler());
  try {
    const text = await (
      await fetch(`${http.base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "draw" }] }),
      })
    ).text();
    assert.ok(text.includes(`/media/${handle}#invisible`), `expected the media URL, got ${text}`);
    assert.ok(!text.includes("[image handle"), "the handle hint never reaches the client");
  } finally {
    await http.close();
  }
});
