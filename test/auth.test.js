import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TokenSource, jwtExpiry, readAuthFile, tokenFromAuth } from "../src/auth.js";
import { startHttpServer, withEndpoints } from "../test-support/helpers.js";

function jwt(expSeconds) {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `header.${payload}.signature`;
}

async function makeCodexHome(tokens) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-proxy-"));
  await writeFile(
    path.join(dir, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens }, null, 2),
    { mode: 0o600 },
  );
  return dir;
}

test("jwtExpiry reads the exp claim and tolerates junk", () => {
  assert.equal(jwtExpiry(jwt(1789500000)), 1789500000 * 1000);
  assert.equal(jwtExpiry("not-a-jwt"), null);
  assert.equal(jwtExpiry("a.!!!.c"), null);
  assert.equal(jwtExpiry(jwt(0)), null);
});

test("tokenFromAuth collects the stored credentials", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const state = tokenFromAuth({ tokens: { access_token: jwt(exp), refresh_token: "r", account_id: "acct" } });
  assert.deepEqual(state.codexToken(), { accessToken: jwt(exp), accountId: "acct" });
  assert.equal(state.validFor(30_000), true);
});

test("readAuthFile rejects anything that is not a ChatGPT login", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-proxy-"));
  const authPath = path.join(dir, "auth.json");

  await assert.rejects(readAuthFile(authPath), /auth file not found/);

  await writeFile(authPath, JSON.stringify({ auth_mode: "apikey", tokens: {} }));
  await assert.rejects(readAuthFile(authPath), /auth mode is "apikey"/);

  await writeFile(authPath, JSON.stringify({ auth_mode: "chatgpt" }));
  await assert.rejects(readAuthFile(authPath), /missing tokens/);
});

test("TokenSource reuses an unexpired access token without refreshing", async () => {
  const dir = await makeCodexHome({
    access_token: jwt(Math.floor(Date.now() / 1000) + 3600),
    refresh_token: "r",
    account_id: "acct",
  });

  const token = await new TokenSource({ codexHome: dir }).token();
  assert.equal(token.accountId, "acct");
  assert.equal(token.accessToken, jwt(Math.floor(Date.now() / 1000) + 3600));
});

test("TokenSource refreshes an expired token and rewrites the auth file", async () => {
  const dir = await makeCodexHome({
    access_token: jwt(Math.floor(Date.now() / 1000) - 3600),
    refresh_token: "old-refresh",
    account_id: "acct",
  });

  let received = null;
  const upstream = await startHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: jwt(Math.floor(Date.now() / 1000) + 3600),
          refresh_token: "new-refresh",
          id_token: "new-id",
        }),
      );
    });
  });

  try {
    const token = await withEndpoints({ refreshURL: `${upstream.base}/oauth/token` }, () =>
      new TokenSource({ codexHome: dir }).token(),
    );

    assert.equal(received.grant_type, "refresh_token");
    assert.equal(received.refresh_token, "old-refresh");
    assert.equal(received.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.equal(token.accessToken, jwt(Math.floor(Date.now() / 1000) + 3600));

    const written = JSON.parse(await readFile(path.join(dir, "auth.json"), "utf8"));
    assert.equal(written.tokens.refresh_token, "new-refresh");
    assert.equal(written.tokens.id_token, "new-id");
    assert.ok(written.last_refresh, "last_refresh should be stamped");
  } finally {
    await upstream.close();
  }
});

test("TokenSource reports a missing refresh token instead of hanging", async () => {
  const dir = await makeCodexHome({ access_token: jwt(Math.floor(Date.now() / 1000) - 3600) });
  await assert.rejects(new TokenSource({ codexHome: dir }).token(), /refresh token is missing/);
});
