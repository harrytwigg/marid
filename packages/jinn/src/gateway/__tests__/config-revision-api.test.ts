import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";

/* The config revision, driven the way the Settings page drives it: read one, edit
 * the file behind the page's back, and try to save. The assertion that matters is
 * not the status code — it is that the bytes on disk are untouched afterwards. */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-config-revision-api-"));
const jinnHome = path.join(root, "instance");
process.env.JINN_HOME = jinnHome;
fs.mkdirSync(jinnHome, { recursive: true });
const configPath = path.join(jinnHome, "config.yaml");

type Api = typeof import("../api.js");

let api: Api;
let currentConfig: JinnConfig;
const emit = vi.fn();

function baseConfig(): JinnConfig {
  return {
    gateway: {},
    engines: { default: "codex", claude: {}, codex: {} },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
  } as unknown as JinnConfig;
}

/** A response that remembers its headers, because the revision travels in one.
 *  `writeHead(status, headers)` merges over `setHeader()` values the way Node does. */
function makeResponse() {
  let status = 200;
  const preset: Record<string, string> = {};
  let written: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const res = {
    setHeader(key: string, value: string) {
      preset[key.toLowerCase()] = value;
      return this;
    },
    writeHead(nextStatus: number, headers?: Record<string, string>) {
      status = nextStatus;
      written = { ...preset };
      for (const [key, value] of Object.entries(headers ?? {})) written[key.toLowerCase()] = value;
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get headers() { return written; },
    get revision() { return written["x-jinn-config-revision"]; },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    method,
    url,
    headers: {
      host: "localhost",
      authorization: "Bearer test-token",
      ...(raw ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } : {}),
      ...headers,
    },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const capture = makeResponse();
  await api.handleApiRequest(
    req as unknown as Parameters<Api["handleApiRequest"]>[0],
    capture.res,
    {
      gatewayAuthToken: "test-token",
      jinnHome,
      getConfig: () => currentConfig,
      connectors: new Map(),
      startTime: Date.now(),
      emit,
      sessionManager: {
        getEngines: () => new Map(),
        getEngine: () => undefined,
        getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_k: string, s: string) => s }),
      },
    } as unknown as import("../api.js").ApiContext,
  );
  return capture;
}

/** The page's own move: load the config and remember what it was reading. */
async function loadPage() {
  const got = await call("GET", "/api/config");
  expect(got.status).toBe(200);
  return got.revision;
}

/** An operator at a terminal, editing the file the page is not watching. */
function handEdit(mutate: (config: Record<string, any>) => void) {
  const doc = yaml.load(fs.readFileSync(configPath, "utf-8")) as Record<string, any>;
  mutate(doc);
  fs.writeFileSync(configPath, yaml.dump(doc));
}

beforeAll(async () => { api = await import("../api.js"); }, 60_000);

beforeEach(() => {
  currentConfig = baseConfig();
  fs.writeFileSync(configPath, yaml.dump(baseConfig()));
  emit.mockClear();
});

afterAll(async () => {
  try { (await import("../../shared/db.js")).__closeDbForTest(); } catch { /* never opened */ }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* Windows can keep a handle past close; the suite already passed. */ }
});

describe("GET /api/config revision", () => {
  it("hands back the sha256 of the bytes on disk", async () => {
    const expected = crypto.createHash("sha256").update(fs.readFileSync(configPath)).digest("hex");

    expect(await loadPage()).toBe(expected);
  });

  it("changes when the file changes, and only then", async () => {
    const first = await loadPage();
    expect(await loadPage()).toBe(first);

    handEdit((doc) => { doc.logging.level = "debug"; });
    expect(await loadPage()).not.toBe(first);
  });

  it("is empty for an instance whose config.yaml does not exist yet", async () => {
    fs.rmSync(configPath);

    expect(await loadPage()).toBe("");
  });
});

describe("PUT /api/config and the model map", () => {
  it("replaces the map rather than unioning it, so removing one entry removes it", async () => {
    fs.writeFileSync(configPath, yaml.dump({
      ...baseConfig(),
      engines: { default: "codex", claude: { fallbackModelMap: { a: "x", b: "y" } }, codex: {} },
    }));

    const put = await call("PUT", "/api/config", {
      engines: { default: "codex", claude: { fallbackModelMap: { a: "x" } }, codex: {} },
    }, { "x-jinn-config-revision": (await loadPage())! });

    expect(put.status).toBe(200);
    const saved = yaml.load(fs.readFileSync(configPath, "utf-8")) as any;
    // Merged, "b" would come straight back off disk and the row would reappear.
    expect(saved.engines.claude.fallbackModelMap).toEqual({ a: "x" });
  });

  it("deletes the whole block when the map is emptied to null", async () => {
    fs.writeFileSync(configPath, yaml.dump({
      ...baseConfig(),
      engines: { default: "codex", claude: { fallbackModelMap: { a: "x" } }, codex: {} },
    }));

    const put = await call("PUT", "/api/config", {
      engines: { default: "codex", claude: { fallbackModelMap: null }, codex: {} },
    }, { "x-jinn-config-revision": (await loadPage())! });

    expect(put.status).toBe(200);
    expect((yaml.load(fs.readFileSync(configPath, "utf-8")) as any).engines.claude.fallbackModelMap).toBeUndefined();
  });
});

describe("PUT /api/config against a stale revision", () => {
  it("refuses the save and leaves the file byte-identical", async () => {
    const stale = await loadPage();
    handEdit((doc) => { doc.logging.level = "debug"; });
    const onDisk = fs.readFileSync(configPath);

    const put = await call("PUT", "/api/config", { logging: { level: "warn" } }, { "x-jinn-config-revision": stale! });

    expect(put.status).toBe(409);
    expect(put.body.code).toBe("CONFIG_CONFLICT");
    expect(put.body.remedy).toBeTruthy();
    // The whole point. Not "the level is still debug" — not one byte moved.
    expect(fs.readFileSync(configPath).equals(onDisk)).toBe(true);
  });

  it("accepts the save once the page has re-read the file", async () => {
    const stale = await loadPage();
    handEdit((doc) => { doc.logging.level = "debug"; });
    expect((await call("PUT", "/api/config", { logging: { level: "warn" } }, { "x-jinn-config-revision": stale! })).status)
      .toBe(409);

    const fresh = await loadPage();
    const put = await call("PUT", "/api/config", { logging: { level: "warn" } }, { "x-jinn-config-revision": fresh! });

    expect(put.status).toBe(200);
    expect((yaml.load(fs.readFileSync(configPath, "utf-8")) as any).logging.level).toBe("warn");
  });

  it("hands back the revision it just wrote, so the page is not stale against its own save", async () => {
    const fresh = await loadPage();

    const put = await call("PUT", "/api/config", { logging: { level: "warn" } }, { "x-jinn-config-revision": fresh! });

    expect(put.status).toBe(200);
    expect(put.revision).toBe(crypto.createHash("sha256").update(fs.readFileSync(configPath)).digest("hex"));
    // And it really is usable: saving straight back with it is not a conflict.
    expect((await call("PUT", "/api/config", { logging: { level: "error" } }, { "x-jinn-config-revision": put.revision })).status)
      .toBe(200);
  });

  it("lets a caller that sends no revision through, the way the voice-setup card does", async () => {
    await loadPage();
    handEdit((doc) => { doc.logging.level = "debug"; });

    const put = await call("PUT", "/api/config", { realtime: { provider: "openai", apiKey: "sk-test" } });

    expect(put.status).toBe(200);
    const saved = yaml.load(fs.readFileSync(configPath, "utf-8")) as any;
    expect(saved.realtime.provider).toBe("openai");
    // The merge kept the hand edit, because nothing stale was written over it.
    expect(saved.logging.level).toBe("debug");
  });
});
