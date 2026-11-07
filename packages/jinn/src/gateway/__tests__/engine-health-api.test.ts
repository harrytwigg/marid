import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import type { ApiContext } from "../api.js";

// Both the registry and the health store freeze paths at import, so the home has
// to be this suite's own before either module is loaded.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-engine-health-api-"));
process.env.JINN_HOME = tmp;

type Api = typeof import("../api.js");
let api: Api;
let recordEngineUnavailable: typeof import("../../shared/engine-health.js").recordEngineUnavailable;
let recordExhaustedWindows: typeof import("../../shared/engine-health.js").recordExhaustedWindows;

beforeAll(async () => {
  api = await import("../api.js");
  ({ recordEngineUnavailable, recordExhaustedWindows } = await import("../../shared/engine-health.js"));
  (await import("../../shared/db.js")).initDb();
}, 60_000);

function cfg(): JinnConfig {
  return {
    gateway: { host: "127.0.0.1", port: 7799 },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.5" },
    },
    models: {
      claude: { default: "opus", models: [{ id: "opus", label: "Opus", supportsEffort: false, effortLevels: [] }] },
      codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5", label: "GPT", supportsEffort: false, effortLevels: [] }] },
    },
    connectors: {},
  } as unknown as JinnConfig;
}

function makeReq(url: string): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = "GET";
  req.url = url;
  req.headers = { host: "localhost", authorization: "Bearer test-token" };
  (req as unknown as { socket: unknown }).socket = { remoteAddress: "127.0.0.1" };
  return req;
}

function makeRes() {
  const chunks: Buffer[] = [];
  const res = {
    writeHead() { return this; },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

function ctx(): ApiContext {
  return {
    getConfig: cfg,
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: vi.fn(),
    sessionManager: { getEngines: () => new Map() },
  } as unknown as ApiContext;
}

async function get(url: string): Promise<Record<string, never>> {
  const res = makeRes();
  await api.handleApiRequest(makeReq(url), res.res, ctx());
  return res.body;
}

describe("engine health on the engine surfaces", () => {
  it("serves the record an availability failure left behind, on both surfaces", async () => {
    const reopensAt = new Date(Date.now() + 90 * 60_000);
    recordEngineUnavailable("codex", "out of quota", reopensAt.getTime() / 1000);
    const expected = { state: "exhausted", until: reopensAt.toISOString(), reason: "out of quota" };

    expect((await get("/api/status")).engines).toMatchObject({ codex: { health: expected } });
    expect((await get("/api/engines")).engines).toMatchObject({ codex: { health: expected } });
  });

  it("reports an engine nothing has been observed on as ok, on both surfaces", async () => {
    expect((await get("/api/status")).engines).toMatchObject({ claude: { health: { state: "ok" } } });
    expect((await get("/api/engines")).engines).toMatchObject({ claude: { health: { state: "ok" } } });
  });

  it("serves a multi-day reset verbatim, with the window that binds it", async () => {
    const reopensAt = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    recordExhaustedWindows("codex", [{ name: "7d", usedPercent: 100, resetsAt: reopensAt.getTime() / 1000 }]);
    const expected = { state: "exhausted", until: reopensAt.toISOString(), window: "7d" };

    expect((await get("/api/status")).engines).toMatchObject({ codex: { health: expected } });
    expect((await get("/api/engines")).engines).toMatchObject({ codex: { health: expected } });
  });

  it("keeps health beside installed availability rather than in place of it", async () => {
    const status = (await get("/api/status")).engines as Record<string, unknown>;

    expect(status.codex).toMatchObject({ model: "gpt-5.5", available: expect.any(Boolean) });
    expect((await get("/api/engines")).engines).toMatchObject({ codex: { name: "codex", defaultModel: "gpt-5.5" } });
  });
});
