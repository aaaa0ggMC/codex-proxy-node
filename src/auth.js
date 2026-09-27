import { readFile, writeFile, rename, chmod, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { stringValue } from "./util.js";
import { endpoints } from "./endpoints.js";

const codexOAuthClientID = "app_EMoamEEZ73f0CkXaXp7hrann";
const refreshSkewMs = 30_000;

// TokenSource reads the ChatGPT login Codex CLI already stored, and refreshes it when the
// access token is about to expire. All work is serialised so two in-flight requests cannot
// both refresh and race on the auth file.
export class TokenSource {
  #lock = Promise.resolve();

  constructor({ codexHome = "" } = {}) {
    this.codexHome = codexHome;
  }

  async token(signal) {
    const run = this.#lock.then(() => this.#token(signal));
    this.#lock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async #token(signal) {
    const authPath = this.#authPath();
    const data = await readAuthFile(authPath);
    let state = tokenFromAuth(data);
    if (state.validFor(refreshSkewMs)) return state.codexToken();
    if (state.refreshToken === "") {
      throw new Error("Codex refresh token is missing; run: codex login");
    }

    const newTokens = await refresh(signal, state.refreshToken);
    mergeTokens(data, newTokens);
    data.last_refresh = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    await writeAuthFile(authPath, data);

    state = tokenFromAuth(data);
    if (state.accessToken === "") {
      throw new Error("token refresh response did not include an access token");
    }
    return state.codexToken();
  }

  #authPath() {
    let home = this.codexHome || process.env.CODEX_HOME || "";
    if (home === "") home = path.join(homedir(), ".codex");
    return path.join(home, "auth.json");
  }
}

class AuthTokenState {
  constructor({ accessToken = "", refreshToken = "", accountId = "", expiresAt = null } = {}) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.accountId = accountId;
    this.expiresAt = expiresAt;
  }

  validFor(skewMs) {
    if (this.accessToken === "") return false;
    if (this.expiresAt == null) return true;
    return Date.now() + skewMs < this.expiresAt;
  }

  codexToken() {
    return { accessToken: this.accessToken, accountId: this.accountId };
  }
}

export async function readAuthFile(authPath) {
  let raw;
  try {
    raw = await readFile(authPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`Codex auth file not found at ${authPath}; run: codex login`);
    }
    throw err;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`read ${authPath}: ${err.message}`);
  }
  if (stringValue(data, "auth_mode") !== "chatgpt") {
    throw new Error(
      `Codex auth mode is ${JSON.stringify(stringValue(data, "auth_mode"))}, expected "chatgpt"; run: codex login`,
    );
  }
  if (data.tokens == null || typeof data.tokens !== "object") {
    throw new Error("Codex auth file is missing tokens; run: codex login");
  }
  return data;
}

export async function writeAuthFile(authPath, data) {
  const body = JSON.stringify(data, null, 2) + "\n";
  const tmp = `${authPath}.tmp.${process.pid}`;
  await writeFile(tmp, body, { mode: 0o600 });
  try {
    await rename(tmp, authPath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await chmod(authPath, 0o600);
}

export function tokenFromAuth(data) {
  const tokens = data?.tokens ?? {};
  const accessToken = stringValue(tokens, "access_token");
  return new AuthTokenState({
    accessToken,
    refreshToken: stringValue(tokens, "refresh_token"),
    accountId: stringValue(tokens, "account_id"),
    expiresAt: jwtExpiry(accessToken),
  });
}

export function mergeTokens(data, updates) {
  const tokens = data.tokens;
  for (const key of ["access_token", "id_token", "refresh_token"]) {
    const value = stringValue(updates, key);
    if (value !== "") tokens[key] = value;
  }
}

export async function refresh(signal, refreshToken) {
  const resp = await fetch(endpoints.refreshURL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: codexOAuthClientID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal,
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(`token refresh failed: HTTP ${resp.status}: ${body.trim()}`);
  }
  return JSON.parse(body);
}

// jwtExpiry reads the `exp` claim without verifying the signature; it is only used to decide
// whether a refresh is due, so an unparsable token simply means "no known expiry".
export function jwtExpiry(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!claims.exp) return null;
    return claims.exp * 1000;
  } catch {
    return null;
  }
}
