import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// Immutable blobs, shared by independent conversation snapshots. Only a snapshot's random
// capability is sent to the client; neither a user name nor a document name selects a session.
// Limits apply to memory and disk alike. A missing blob is reported, never replaced by a guess.
export class ContextStore {
  #entries = new Map();
  #bytes = 0;
  #ready = false;
  #queue = Promise.resolve();

  constructor({ directory = "", maxBytes = 256 * 1024 * 1024, maxEntries = 4096 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("context store limits must be positive integers");
    }
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  #locked(fn) {
    const result = this.#queue.then(async () => {
      await this.#init();
      return fn();
    });
    this.#queue = result.catch(() => {});
    return result;
  }

  async #init() {
    if (this.#ready) return;
    if (this.directory !== "") {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const entries = [];
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const info = await stat(path.join(this.directory, name));
        if (info.isFile()) entries.push([name.slice(0, -5), { bytes: info.size, time: info.mtimeMs }]);
      }
      entries.sort((a, b) => a[1].time - b[1].time);
      for (const [id, entry] of entries) {
        this.#entries.set(id, entry);
        this.#bytes += entry.bytes;
      }
      await this.#prune();
    }
    this.#ready = true;
  }

  async #prune() {
    while (this.#bytes > this.maxBytes || this.#entries.size > this.maxEntries) {
      const [id, entry] = this.#entries.entries().next().value;
      if (this.directory !== "") {
        await unlink(path.join(this.directory, `${id}.json`)).catch((err) => {
          if (err.code !== "ENOENT") throw err;
        });
      }
      this.#entries.delete(id);
      this.#bytes -= entry.bytes;
    }
  }

  put(value) {
    return this.#locked(async () => {
      const json = JSON.stringify(value);
      const bytes = Buffer.byteLength(json);
      // Oversized results are still given to the current model, but cannot be promised for replay.
      if (bytes > this.maxBytes) return null;
      const id = createHash("sha256").update(json).digest("hex");
      if (!this.#entries.has(id)) {
        if (this.directory !== "") await writeFile(path.join(this.directory, `${id}.json`), json, { mode: 0o600 });
        this.#entries.set(id, { bytes, ...(this.directory === "" ? { json } : {}) });
        this.#bytes += bytes;
        await this.#prune();
      }
      return id;
    });
  }

  get(id) {
    if (!/^[a-f0-9]{64}$/.test(String(id))) return Promise.resolve(null);
    return this.#locked(async () => {
      const entry = this.#entries.get(id);
      if (entry == null) return null;
      let json;
      try {
        json = this.directory === "" ? entry.json : await readFile(path.join(this.directory, `${id}.json`), "utf8");
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
        this.#entries.delete(id);
        this.#bytes -= entry.bytes;
        return null;
      }
      // Detect partial writes or damaged files instead of restoring misleading evidence.
      if (createHash("sha256").update(json).digest("hex") !== id) return null;
      try {
        const value = JSON.parse(json);
        this.#entries.delete(id);
        this.#entries.set(id, entry);
        return value;
      } catch {
        return null;
      }
    });
  }
}
