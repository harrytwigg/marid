import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-config-known-keys-"));
const jinnHome = path.join(root, "instance");
process.env.JINN_HOME = jinnHome;
fs.mkdirSync(jinnHome, { recursive: true });

type Api = typeof import("../api.js");

let api: Api;
let currentConfig: JinnConfig;

function baseConfig(): JinnConfig {
  return {
    gateway: {},
    engines: { default: "codex", claude: {} },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
  } as unknown as JinnConfig;
}

function makeResponse() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

async function call(method: string, url: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    method,
    url,
    headers: {
      host: "localhost",
      authorization: "Bearer test-token",
      ...(raw ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } : {}),
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
      // The live gateway refreshes its in-memory copy before it answers the PUT, so a
      // follow-up GET reads what landed on disk rather than the pre-write object.
      reloadConfig: () => {
        currentConfig = yaml.load(fs.readFileSync(path.join(jinnHome, "config.yaml"), "utf-8")) as JinnConfig;
      },
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: { getEngines: () => new Map(), getEngine: () => undefined },
    } as unknown as import("../api.js").ApiContext,
  );
  return capture;
}

function savedConfig(): Record<string, any> {
  return yaml.load(fs.readFileSync(path.join(jinnHome, "config.yaml"), "utf-8")) as Record<string, any>;
}

beforeAll(async () => {
  api = await import("../api.js");
});

beforeEach(() => {
  currentConfig = baseConfig();
  fs.writeFileSync(path.join(jinnHome, "config.yaml"), yaml.dump(currentConfig));
});

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

describe("PUT /api/config top-level key allowlist", () => {
  it("accepts and persists a stale workflows block, though Workflows are gone", async () => {
    const response = await call("PUT", "/api/config", {
      workflows: {
        armingDelegates: ["platform-delegate"],
        delivery: { remote: "upstream", branch: "stable" },
      },
    });

    expect(response.status).toBe(200);
    expect(savedConfig().workflows).toEqual({
      armingDelegates: ["platform-delegate"],
      delivery: { remote: "upstream", branch: "stable" },
    });
  });

  it("round-trips a gateway whose config still carries a stale workflows block", async () => {
    currentConfig = { ...baseConfig(), workflows: { armingDelegates: ["platform-delegate"] } };
    fs.writeFileSync(path.join(jinnHome, "config.yaml"), yaml.dump(currentConfig));

    const fetched = await call("GET", "/api/config");
    expect(fetched.status).toBe(200);

    const saved = await call("PUT", "/api/config", fetched.body);
    expect(saved.status).toBe(200);
    expect(savedConfig().workflows).toEqual({ armingDelegates: ["platform-delegate"] });
  });

  it("accepts and persists the realtime block", async () => {
    const response = await call("PUT", "/api/config", {
      realtime: { provider: "openai", apiKey: "sk-account-key" },
    });

    expect(response.status).toBe(200);
    expect(savedConfig().realtime).toEqual({ provider: "openai", apiKey: "sk-account-key" });
  });

  // The Settings page saves the whole document it was served, so the key it
  // sends back is the "***" it was given. Saving must therefore be a no-op on
  // the key rather than a way to overwrite it with the sentinel.
  it("round-trips a realtime gateway without overwriting the key it redacted", async () => {
    currentConfig = { ...baseConfig(), realtime: { provider: "openai", apiKey: "sk-account-key" } };
    fs.writeFileSync(path.join(jinnHome, "config.yaml"), yaml.dump(currentConfig));

    const fetched = await call("GET", "/api/config");
    expect(fetched.status).toBe(200);
    expect(fetched.body.realtime.apiKey).toBe("***");

    const saved = await call("PUT", "/api/config", fetched.body);
    expect(saved.status).toBe(200);
    expect(savedConfig().realtime).toEqual({ provider: "openai", apiKey: "sk-account-key" });
  });

  // Omitting a key is how the page says "leave this alone", so it cannot also be
  // how it says "clear this" — the UI sends null, and the merge has to honour it
  // rather than report a save that put the old value straight back.
  it("clears a field the caller sends as null, and keeps the ones it did not mention", async () => {
    currentConfig = { ...baseConfig(), realtime: { provider: "openai", apiKey: "sk-account-key" } };
    fs.writeFileSync(path.join(jinnHome, "config.yaml"), yaml.dump(currentConfig));

    const cleared = await call("PUT", "/api/config", {
      realtime: { provider: null, apiKey: "***" },
    });

    expect(cleared.status).toBe(200);
    expect(savedConfig().realtime).toEqual({ apiKey: "sk-account-key" });
  });

  it("accepts and persists the plugins block the toggle writes", async () => {
    const response = await call("PUT", "/api/config", { plugins: { enabled: ["inbox"], disabled: [] } });

    expect(response.status).toBe(200);
    expect(savedConfig().plugins).toEqual({ enabled: ["inbox"], disabled: [] });
  });

  it("accepts and persists the budgets block", async () => {
    const response = await call("PUT", "/api/config", { budgets: { employees: { "a-lead": 25 } } });

    expect(response.status).toBe(200);
    expect(savedConfig().budgets).toEqual({ employees: { "a-lead": 25 } });
  });

  // The Settings page saves back the whole document it was served, so a plugin the operator toggled must survive it.
  it("round-trips a gateway that already has plugins decided", async () => {
    currentConfig = { ...baseConfig(), plugins: { enabled: ["inbox"], disabled: [] } } as JinnConfig;
    fs.writeFileSync(path.join(jinnHome, "config.yaml"), yaml.dump(currentConfig));

    const fetched = await call("GET", "/api/config");
    expect(fetched.status).toBe(200);

    const saved = await call("PUT", "/api/config", fetched.body);
    expect(saved.status).toBe(200);
    expect(savedConfig().plugins).toEqual({ enabled: ["inbox"], disabled: [] });
  });

  it("still refuses a key JinnConfig does not declare", async () => {
    const response = await call("PUT", "/api/config", { nonsense: true });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Unknown config keys: nonsense");
  });

  // A boolean field given a string parses fine but makes loadConfig() throw, costing the operator the next restart.
  it("refuses a value that would brick the next boot, and leaves the file alone", async () => {
    const before = fs.readFileSync(path.join(jinnHome, "config.yaml"), "utf-8");

    const response = await call("PUT", "/api/config", { gateway: { authDisabled: "yes" } });

    expect(response.status).toBe(400);
    expect(fs.readFileSync(path.join(jinnHome, "config.yaml"), "utf-8")).toBe(before);
  });

  // A tab-joined "id<TAB>label" composite is a nonempty string, so only the control
  // character catches it — and it has to be caught here, before it is on disk.
  it("refuses a fallbackModelMap entry that is not a model id, and leaves the file alone", async () => {
    const before = fs.readFileSync(path.join(jinnHome, "config.yaml"), "utf-8");

    const response = await call("PUT", "/api/config", {
      engines: {
        default: "codex",
        claude: {},
        codex: { fallbackModelMap: { "gpt-5.6-sol": "gemini-3.7-flash-high\tGemini 3.7 Flash (High)" } },
      },
    });

    expect(response.status).toBe(400);
    expect(String(response.body.error)).toContain(
      'engines.codex.fallbackModelMap["gpt-5.6-sol"] must be a model id with no control characters',
    );
    expect(fs.readFileSync(path.join(jinnHome, "config.yaml"), "utf-8")).toBe(before);
  });

  // Rewriting a config we could not parse recreates it from the body alone, taking engines, connectors and tokens.
  it("refuses to rewrite a config.yaml it could not read as an object", async () => {
    const malformed = "gateway: {\nengines: [oops\n";
    fs.writeFileSync(path.join(jinnHome, "config.yaml"), malformed);

    const response = await call("PUT", "/api/config", { logging: { level: "debug" } });

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(fs.readFileSync(path.join(jinnHome, "config.yaml"), "utf-8")).toBe(malformed);
  });
});

// The Settings page has no Save button: a write it cannot land is a setting that
// silently reverts on the next reload. It reverted for a whole config.yaml because
// the document GET served carried a key the PUT then refused.
describe("a config.yaml carrying a key this build does not declare", () => {
  beforeEach(() => {
    currentConfig = { ...baseConfig(), sessions: { interruptOnNewMessage: true } } as JinnConfig;
    fs.writeFileSync(
      path.join(jinnHome, "config.yaml"),
      yaml.dump({ ...currentConfig, remotes: { peer: { url: "http://peer.invalid/" } } }),
    );
    currentConfig = yaml.load(fs.readFileSync(path.join(jinnHome, "config.yaml"), "utf-8")) as JinnConfig;
  });

  it("does not serve the key it would refuse back", async () => {
    const fetched = await call("GET", "/api/config");

    expect(fetched.status).toBe(200);
    expect(fetched.body.remotes).toBeUndefined();
    expect(fetched.body.sessions).toEqual({ interruptOnNewMessage: true });
  });

  it("saves a false the page turned off, and reads it back off disk", async () => {
    const fetched = await call("GET", "/api/config");
    const edited = { ...fetched.body, sessions: { ...fetched.body.sessions, interruptOnNewMessage: false } };

    const saved = await call("PUT", "/api/config", edited);

    expect(saved.status).toBe(200);
    expect(savedConfig().sessions.interruptOnNewMessage).toBe(false);
    expect((await call("GET", "/api/config")).body.sessions.interruptOnNewMessage).toBe(false);
  });

  it("keeps the undeclared key on disk rather than dropping it on the next save", async () => {
    const fetched = await call("GET", "/api/config");

    expect((await call("PUT", "/api/config", fetched.body)).status).toBe(200);
    expect(savedConfig().remotes).toEqual({ peer: { url: "http://peer.invalid/" } });
  });
});
