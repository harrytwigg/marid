import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPLOYEE,
  connectorMessage,
  connectorStub,
  createTestHome,
  engineResult,
  eventually,
  scriptedEngine,
  testConfig,
} from "./helpers/turn-parity-harness.js";
import type { JinnConfig } from "../../shared/types.js";

/**
 * Muse Code through the turn runner, not only through its engine: the real
 * adapter against the fake `muse serve`, settled the way the gateway settles a
 * turn. What is asserted is what the session and its operator end up with.
 *
 *  - a conversation Muse no longer has is started again, in a fresh one handed
 *    the session so far, and the message is still answered;
 *  - a usage limit goes down the existing rate-limit path with Muse's own reset
 *    time: to the fallback engine when there is one, else the session waits.
 */

createTestHome("jinn-musecode-runner-");
const dbModule = await import("../../shared/db.js");
const { formatResumeTime } = await import("../turn/text.js");
const { MusecodeEngine } = await import("../../engines/musecode.js");

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engines", "__tests__", "fixtures", "fake-muse.mjs");

let registry: typeof import("../registry.js");
let ManagerClass: typeof import("../manager.js").SessionManager;
let stateDir: string;
let logFile: string;
let engine: InstanceType<typeof MusecodeEngine>;

beforeAll(async () => {
  [registry, { SessionManager: ManagerClass }] = await Promise.all([import("../registry.js"), import("../manager.js")]);
  dbModule.initDb();
});

beforeEach(() => {
  dbModule.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "musecode-runner-"));
  logFile = path.join(stateDir, "requests.jsonl");
  vi.stubEnv("FAKE_MUSE_STATE_DIR", path.join(stateDir, "state"));
  vi.stubEnv("FAKE_MUSE_LOG", logFile);
  engine = new MusecodeEngine();
});

afterEach(() => {
  engine.killAll();
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const employee = { name: EMPLOYEE, engine: "musecode", persona: "Muse Code fixture" };

function config(over: Partial<JinnConfig["engines"]> = {}): JinnConfig {
  return testConfig({ engines: { default: "claude", claude: { bin: process.execPath }, musecode: { bin: FAKE }, ...over } } as Partial<JinnConfig>);
}

/** Every request the fake host received, in order, across all its processes. */
function methods(): string[] {
  return fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.method).map((r) => r.method as string);
}

describe("a conversation Muse no longer has", () => {
  it("is started again in a fresh one that is handed the session so far, and the message is answered", async () => {
    const manager = new ManagerClass(config(), new Map([["musecode", engine]]) as never, "musecode-boot");
    const key = `stub:musecode-${Math.random().toString(16).slice(2)}`;

    // The first turn answers; then the host forgets the conversation it just held.
    const first = await manager.route(connectorMessage(key, "one\n---\nNOTFOUND"), connectorStub(), { employee: employee as never });
    const id = first!.sessionId;
    const lost = registry.getEngineSessionRef(registry.getSession(id)!, "musecode").id;
    expect(lost).toMatch(/^[0-9a-f]{8}-/);

    const connector = connectorStub();
    await manager.route(connectorMessage(key, "two"), connector, { employee: employee as never });

    const session = registry.getSession(id)!;
    expect(session).toMatchObject({ status: "idle", lastError: null });
    const fresh = registry.getEngineSessionRef(session, "musecode").id;
    expect(fresh).toMatch(/^[0-9a-f]{8}-/);
    expect(fresh).not.toBe(lost);
    // Resumed the lost id (refused), then started a new session and ran the turn there, in one go.
    const order = methods();
    const resumeAt = order.lastIndexOf("session/resume");
    expect(order.slice(resumeAt)).toEqual(["session/resume", "initialize", "initialized", "session/start", "turn/start"]);
    const answers = registry.getMessages(id).filter((m) => m.role === "assistant").map((m) => m.content);
    const answer = answers.at(-1)!;
    expect(answer).toContain("could not be resumed");
    expect(answer).toContain("USER: one");
    expect(answer).toMatch(/CURRENT MESSAGE:\ntwo$/);
    expect(connector.replies.join("\n")).not.toContain("has no conversation");
    expect(registry.getMessages(id).some((m) => m.content.includes("has no conversation"))).toBe(false);
  }, 60_000);
});

describe("a failed turn on a resumed conversation", () => {
  it("keeps the conversation when the failure reads like a dead session, and does not re-run it in a fresh one", async () => {
    const manager = new ManagerClass(config(), new Map([["musecode", engine]]) as never, "musecode-boot");
    const key = `stub:musecode-${Math.random().toString(16).slice(2)}`;
    const first = await manager.route(connectorMessage(key, "one"), connectorStub(), { employee: employee as never });
    const id = first!.sessionId;
    const kept = registry.getEngineSessionRef(registry.getSession(id)!, "musecode").id;

    // The fake's AUTH failure says "Your session has expired, please log in again".
    await manager.route(connectorMessage(key, "two\n---\nAUTH"), connectorStub(), { employee: employee as never });

    const session = registry.getSession(id)!;
    expect(session.status).toBe("error");
    expect(session.lastError).toMatch(/muse login/);
    expect(registry.getEngineSessionRef(session, "musecode").id).toBe(kept);
    // One session was started, and the second turn resumed it once: nothing was started afresh.
    const order = methods();
    expect(order.filter((m) => m === "session/start")).toHaveLength(1);
    expect(order.filter((m) => m === "session/resume")).toHaveLength(1);

    // The next message resumes the same conversation.
    await manager.route(connectorMessage(key, "three"), connectorStub(), { employee: employee as never });
    expect(registry.getSession(id)!.status).toBe("idle");
    expect(registry.getEngineSessionRef(registry.getSession(id)!, "musecode").id).toBe(kept);
    expect(methods().filter((m) => m === "session/resume")).toHaveLength(2);
  }, 60_000);
});

describe("a Muse Code usage limit", () => {
  it("moves the session to the fallback engine, announcing Muse's own reset time", async () => {
    const resetsAtMs = Math.floor((Date.now() + 5 * 3600_000) / 1000) * 1000;
    vi.stubEnv("FAKE_MUSE_RESET_MS", String(resetsAtMs));
    const claude = scriptedEngine("claude", [engineResult({ result: "answered by claude", sessionId: "claude-native", cost: 0.01, numTurns: 1 })]);
    const manager = new ManagerClass(
      config({ musecode: { bin: FAKE, fallback: ["claude"] } } as never),
      new Map<string, unknown>([["musecode", engine], ["claude", claude]]) as never,
      "musecode-boot",
    );
    const connector = connectorStub();
    const routed = await manager.route(connectorMessage(`stub:musecode-${Math.random().toString(16).slice(2)}`, "hello\n---\nQUOTA"), connector, { employee: employee as never });
    const id = routed!.sessionId;
    await eventually(() => registry.getSession(id)?.status === "idle", 30_000);

    expect(claude.runs).toBe(1);
    const session = registry.getSession(id)!;
    expect(session.engine).toBe("claude");
    // The notice names the engine by its label and the reset by the time Muse reported.
    const notice = connector.replies.find((r) => r.includes("usage limit reached"));
    expect(notice).toBe(`⚠️ Muse Code usage limit reached. Resets ${formatResumeTime(new Date(resetsAtMs))}. Switching to Claude for now.`);
    expect(registry.getMessages(id).map((m) => m.content)).toContain("answered by claude");
  }, 60_000);

  it("waits for the reset, announcing it, when there is nothing to fall back to", async () => {
    const resetsAtMs = Math.floor((Date.now() + 2 * 3600_000) / 1000) * 1000;
    vi.stubEnv("FAKE_MUSE_RESET_MS", String(resetsAtMs));
    const manager = new ManagerClass(config(), new Map([["musecode", engine]]) as never, "musecode-boot");
    const connector = connectorStub();
    const routing = manager.route(connectorMessage(`stub:musecode-${Math.random().toString(16).slice(2)}`, "hello\n---\nQUOTA"), connector, { employee: employee as never });
    await eventually(() => connector.replies.some((r) => r.includes("usage limit reached")), 30_000);

    expect(connector.replies.find((r) => r.includes("usage limit reached")))
      .toBe(`⏳ Muse Code usage limit reached. Resets ${formatResumeTime(new Date(resetsAtMs))} — I'll continue automatically.`);
    const [row] = dbModule.initDb().prepare("SELECT id, status, engine FROM sessions").all() as Array<{ id: string; status: string; engine: string }>;
    expect(row).toMatchObject({ status: "waiting", engine: "musecode" });
    // The conversation Muse started is kept through the wait: a usage limit is not a lost conversation.
    expect(registry.getEngineSessionRef(registry.getSession(row!.id)!, "musecode").id).toMatch(/^[0-9a-f]{8}-/);

    // Stopping the session ends the wait.
    registry.updateSession(row!.id, { status: "idle" });
    await routing;
  }, 60_000);
});
