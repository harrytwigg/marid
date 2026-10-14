import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { Employee, JinnConfig, Session } from "../../shared/types.js";

/**
 * A session created while its employee's engine is out of allowance starts on
 * the fallback — and has to say what it left, or it never goes back. Driven
 * through each gateway path that creates an employee session, since each one
 * builds the row itself: a spawn, a Todo wake, a delegation.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-fallback-reroute-creation-"));
process.env.JINN_HOME = home;
fs.mkdirSync(path.join(home, "org"), { recursive: true });
fs.writeFileSync(
  path.join(home, "org", "a-worker.yaml"),
  [
    "name: a-worker", "displayName: A Worker", "department: platform", "rank: employee",
    "engine: claude", "model: opus", "persona: Fallback reroute fixture", "",
  ].join("\n"),
);
const HEALTH_PATH = path.join(home, "tmp", "engine-health.json");

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const dbModule = await import("../../shared/db.js");
let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let workItems: typeof import("../../work-items/store.js");
let spawnSession: typeof import("../spawn-session.js").spawnSession;
let wakeEmployeeOnTodo: typeof import("../todo-employee-session.js").wakeEmployeeOnTodo;

/** Never answers: the test reads the row the creation path wrote, not a turn. */
const engineStub = {
  name: "stub",
  run: () => new Promise(() => {}),
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};

const queueStub = {
  enqueue: async () => {},
  clearCancelled: () => {},
  clearQueue: () => {},
  holdForCallbackDrain: () => {},
  releaseCallbackDrain: () => {},
  hasInFlightItem: () => false,
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};

const config = {
  gateway: { port: 7798, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "opus", fallback: ["codex"] },
    codex: { bin: "codex", model: "gpt-5.6-sol" },
  },
  models: {
    claude: { default: "opus", models: [{ id: "opus" }] },
    codex: { default: "gpt-5.6-sol", models: [{ id: "gpt-5.6-sol" }] },
  },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
  mcp: { gateway: { enabled: true } },
} as unknown as JinnConfig;

const context = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => undefined,
  reloadOrg: () => {},
  sessionManager: {
    getEngine: () => engineStub,
    getEngines: () => new Map([["claude", engineStub], ["codex", engineStub]]),
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  let status = 200;
  let raw = "";
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url,
    headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json" },
  });
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { if (chunk) raw += chunk.toString(); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as never, res, context);
  return { status, body: raw ? JSON.parse(raw) : undefined };
}

const RESET = new Date(Date.now() + 60 * 60_000);

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  workItems = await import("../../work-items/store.js");
  ({ spawnSession } = await import("../spawn-session.js"));
  ({ wakeEmployeeOnTodo } = await import("../todo-employee-session.js"));
  dbModule.initDb();
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate({ ok: true });
});

afterAll(async () => {
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate(null);
});

beforeEach(() => {
  fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
  fs.writeFileSync(HEALTH_PATH, JSON.stringify({
    claude: { state: "exhausted", until: RESET.toISOString(), recheckAt: RESET.toISOString(), reason: "quota window spent" },
  }));
});

/** The row as the creation path wrote it: on the fallback, owing a return to claude at the reset. */
function expectRerouted(session: Session): void {
  expect(session.engine).toBe("codex");
  const record = (session.transportMeta as Record<string, Record<string, unknown>> | null)?.engineOverride;
  expect(record).toMatchObject({ originalEngine: "claude", originalModel: "opus", originalEngineSessionId: null });
  expect(Date.parse(String(record!.until))).toBe(RESET.getTime());
}

describe("an employee session created while its engine is out of allowance", () => {
  it("records the way back when spawned", async () => {
    const spawned = await spawnSession(context, { prompt: "spawned brief", employee: "a-worker" });
    expect(spawned.ok).toBe(true);
    expectRerouted(registry.getSession((spawned as { session: Session }).session.id)!);
  });

  it("records the way back when woken on a Todo", () => {
    const item = workItems.createWorkItem({ title: "Wake target", source: "human" });
    const woken = wakeEmployeeOnTodo(context, {
      workItemId: item.id,
      employee: { name: "a-worker", engine: "claude", model: "opus", persona: "fixture" } as Employee,
      role: "execute",
      actor: "test",
      title: "Wake target",
      sourceAttempt: "wake-1",
      deliveryKind: "todo_wake",
      message: "woken brief",
      displayMessage: "woken brief",
    });
    expect(woken.ok).toBe(true);
    expectRerouted(registry.getSession((woken as { session: Session }).session.id)!);
  });

  it("records the way back when delegated, alongside the delegation's own meta", async () => {
    const delegated = await post("/api/delegations", { employee: "a-worker", task: "Delegated brief with acceptance." });
    expect(delegated.status).toBe(201);
    const session = registry.getSession(delegated.body.sessionId)!;
    expectRerouted(session);
    expect(Object.keys(session.transportMeta ?? {}).length).toBeGreaterThan(1);
  });

  it("starts on the employee's own engine, with no record, while its allowance holds", async () => {
    fs.rmSync(HEALTH_PATH, { force: true });
    const spawned = await spawnSession(context, { prompt: "healthy brief", employee: "a-worker" });
    const session = registry.getSession((spawned as { session: Session }).session.id)!;
    expect(session.engine).toBe("claude");
    expect((session.transportMeta as Record<string, unknown> | null)?.engineOverride).toBeUndefined();
  });
});
