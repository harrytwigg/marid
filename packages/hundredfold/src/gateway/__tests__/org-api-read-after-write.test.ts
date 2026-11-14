import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { HundredfoldConfig } from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-org-raw-"));
process.env.HUNDREDFOLD_HOME = home;
fs.mkdirSync(path.join(home, "org"), { recursive: true });
fs.writeFileSync(
  path.join(home, "org", "roster-worker.yaml"),
  [
    "name: roster-worker",
    "displayName: Roster Worker",
    "department: platform",
    "rank: employee",
    "engine: codex",
    "model: gpt-5.6-sol",
    "persona: Completes bounded platform work",
    "",
  ].join("\n"),
);

const dbModule = await import("../../shared/db.js");

type Api = typeof import("../api.js");

let api: Api;

// Production hands the same config object out on every getConfig() call, so the
// read owner's cache is live here — a stale re-read would surface.
const config = {
  gateway: { port: 7799, host: "127.0.0.1" },
  engines: {
    default: "codex",
    claude: { bin: "claude", model: "opus" },
    codex: { bin: "codex", model: "gpt-5.6-sol", effortLevel: "high" },
  },
  models: {
    claude: { default: "opus", models: [{ id: "opus", supportsEffort: false }] },
    codex: {
      default: "gpt-5.6-sol",
      models: [
        { id: "gpt-5.6-sol", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "gpt-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    },
  },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
  mcp: { gateway: { enabled: true } },
} as unknown as HundredfoldConfig;

const context = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  // The gateway wires this to a real refresh; harnesses stub it, which is
  // exactly the case the write path must not depend on.
  reloadOrg: () => {},
  sessionManager: {
    getEngine: () => undefined,
    getEngines: () => new Map(),
  },
} as unknown as import("../api.js").ApiContext;

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
    get body(): any {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

async function call(method: string, url: string, body?: unknown) {
  const request = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    {
      method,
      url,
      headers: {
        host: "localhost",
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
    },
  );
  const captured = makeResponse();
  await api.handleApiRequest(
    request as unknown as Parameters<Api["handleApiRequest"]>[0],
    captured.res,
    context,
  );
  return { status: captured.status, body: captured.body };
}

beforeAll(async () => {
  api = await import("../api.js");
  dbModule.initDb();
}, 60_000);

afterAll(async () => {
  dbModule.__closeDbForTest();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* Windows can keep a handle past close; the suite already passed. */ }
});

describe("PATCH /api/org/employees/:name — read after write", () => {
  it("returns the value it just wrote, not the roster it read before writing", async () => {
    const before = await call("GET", "/api/org/employees/roster-worker");
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ name: "roster-worker", model: "gpt-5.6-sol" });

    const patched = await call("PATCH", "/api/org/employees/roster-worker", { model: "gpt-5.5" });
    expect(patched.status).toBe(200);
    expect(patched.body.employee).toMatchObject({ name: "roster-worker", model: "gpt-5.5" });

    const after = await call("GET", "/api/org/employees/roster-worker");
    expect(after.body).toMatchObject({ name: "roster-worker", model: "gpt-5.5" });
  });
});
