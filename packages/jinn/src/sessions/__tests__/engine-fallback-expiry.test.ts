import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  apiContext,
  connectorMessage,
  connectorStub,
  createTestHome,
  engineResult,
  eventually,
  scriptedEngine,
  testConfig,
  type ScriptedEngine,
} from "./helpers/turn-parity-harness.js";
import type { EngineResult, JinnConfig } from "../../shared/types.js";

/**
 * A fallback taken because the primary engine ran out of allowance is temporary.
 * Every session moved onto a stand-in — mid-turn, or at creation because the
 * primary was already known to be spent — carries the moment its primary
 * reopens, and the first turn after that moment runs on the primary again.
 * A primary still limited at that turn falls back once more, with the new reset.
 */

const HOME = createTestHome("jinn-fallback-expiry-");
const HEALTH_PATH = path.join(HOME, "tmp", "engine-health.json");
const dbModule = await import("../../shared/db.js");

let registry: typeof import("../registry.js");
let ManagerClass: typeof import("../manager.js").SessionManager;
let dispatchWebSessionRun: typeof import("../../gateway/web-session-dispatch.js").dispatchWebSessionRun;
let readEngineHealth: typeof import("../../shared/engine-health.js").readEngineHealth;
let validateNewSessionSelection: typeof import("../session-patch.js").validateNewSessionSelection;
let reroutedSessionMeta: typeof import("../engine-override.js").reroutedSessionMeta;

beforeAll(async () => {
  [registry, { SessionManager: ManagerClass }, { dispatchWebSessionRun }, { readEngineHealth }, { validateNewSessionSelection }, { reroutedSessionMeta }] =
    await Promise.all([
      import("../registry.js"),
      import("../manager.js"),
      import("../../gateway/web-session-dispatch.js"),
      import("../../shared/engine-health.js"),
      import("../session-patch.js"),
      import("../engine-override.js"),
    ]);
  dbModule.initDb();
});

const START = new Date("2026-10-14T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  dbModule.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  fs.rmSync(HEALTH_PATH, { force: true });
  // Only the clock is faked: turns still settle on real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

const employee = { name: "a-worker", engine: "claude", model: "opus", persona: "Fallback expiry fixture" };

/** Claude is the primary, codex its fallback. */
function config(): JinnConfig {
  const base = testConfig() as unknown as Record<string, unknown>;
  const engines = base["engines"] as Record<string, unknown>;
  engines["claude"] = { bin: process.execPath, model: "opus", fallback: ["codex"] };
  engines["codex"] = { bin: process.execPath, model: "gpt-5.6-sol" };
  base["models"] = {
    claude: { default: "opus", models: [{ id: "opus" }] },
    codex: { default: "gpt-5.6-sol", models: [{ id: "gpt-5.6-sol" }] },
  };
  return base as unknown as JinnConfig;
}

/** The limit error the primary reports, naming when it resets. */
function limitedUntil(reset: Date): EngineResult {
  return engineResult({
    error: "429 usage limit reached",
    rateLimit: { status: "rejected", resetsAt: Math.floor(reset.getTime() / 1000) },
  } as Partial<EngineResult>);
}

const answer = (text: string, sessionId: string) => engineResult({ result: text, sessionId });

function harness(claudeScript: EngineResult[], codexScript: EngineResult[] = [answer("codex answer", "codex-thread")]) {
  const claude = scriptedEngine("claude", claudeScript);
  const codex = scriptedEngine("codex", codexScript);
  const cfg = config();
  const manager = new ManagerClass(cfg, new Map([["claude", claude as never], ["codex", codex as never]]), "expiry-boot");
  return { manager, claude, codex, cfg };
}

function settled(id: string): boolean {
  const status = registry.getSession(id)?.status;
  return status === "idle" || status === "error" || status === "interrupted";
}

/** One connector turn on `key`; resolves once it has settled. */
async function turn(manager: InstanceType<typeof ManagerClass>, key: string, text: string): Promise<string> {
  const existing = registry.getSessionBySessionKey(key);
  const before = existing ? answers(existing.id) : 0;
  const routed = await manager.route(connectorMessage(key, text), connectorStub(), { employee: employee as never });
  const id = routed!.sessionId;
  // The route resolves once the turn is queued; wait for its answer and its settle.
  await eventually(() => answers(id) > before && settled(id));
  return id;
}

function answers(id: string): number {
  return registry.getMessages(id).filter((m) => m.role === "assistant").length;
}

/** Engine runs, read after the turn so a lagging settle cannot hide one. */
function runs(engine: ScriptedEngine): number {
  return engine.runs;
}

function override(id: string): Record<string, unknown> | undefined {
  return (registry.getSession(id)!.transportMeta as Record<string, Record<string, unknown>> | null)?.engineOverride;
}

describe("a session the primary's usage limit moved onto the fallback mid-turn", () => {
  it("answers on the fallback, then on the primary again at the first turn after the reset", async () => {
    const reset = new Date(START.getTime() + HOUR);
    const { manager, claude, codex } = harness([limitedUntil(reset), answer("claude is back", "claude-thread-2")]);
    const key = "stub:expiry-mid-turn";

    const id = await turn(manager, key, "first");
    expect(runs(claude)).toBe(1);
    expect(runs(codex)).toBe(1);
    expect(registry.getSession(id)!.engine).toBe("codex");
    expect(override(id)).toMatchObject({ originalEngine: "claude", originalModel: "opus" });
    expect(Date.parse(String(override(id)!.until))).toBe(reset.getTime());

    // Before the reset: the next turn stays on the fallback.
    vi.setSystemTime(new Date(START.getTime() + 30 * MINUTE));
    await turn(manager, key, "second");
    expect(runs(codex)).toBe(2);
    expect(runs(claude)).toBe(1);
    expect(registry.getSession(id)!.engine).toBe("codex");

    // After the reset: the primary answers, on its own pin, with nothing left over.
    vi.setSystemTime(new Date(START.getTime() + 2 * HOUR));
    await turn(manager, key, "third");
    expect(runs(claude)).toBe(2);
    expect(runs(codex)).toBe(2);
    const back = registry.getSession(id)!;
    expect(back.engine).toBe("claude");
    expect(back.model).toBe("opus");
    expect(override(id)).toBeUndefined();
  }, 30_000);

  it("stays on the fallback when the primary is still limited at the reset, and re-checks at the new one", async () => {
    const firstReset = new Date(START.getTime() + HOUR);
    const secondReset = new Date(START.getTime() + 3 * HOUR);
    const { manager, claude, codex } = harness(
      [limitedUntil(firstReset), limitedUntil(secondReset), answer("claude is back", "claude-thread-2")],
      [answer("codex 1", "codex-thread"), answer("codex 2", "codex-thread"), answer("codex 3", "codex-thread")],
    );
    const key = "stub:expiry-still-limited";

    const id = await turn(manager, key, "first");
    expect(registry.getSession(id)!.engine).toBe("codex");

    // Past the first reset the primary is tried again — and is still limited, so the turn falls back once more.
    vi.setSystemTime(new Date(START.getTime() + 2 * HOUR));
    await turn(manager, key, "second");
    expect(runs(claude)).toBe(2);
    expect(runs(codex)).toBe(2);
    expect(registry.getSession(id)!.engine).toBe("codex");
    expect(Date.parse(String(override(id)!.until))).toBe(secondReset.getTime());

    // Before the second reset: no probe of the primary.
    vi.setSystemTime(new Date(START.getTime() + 2.5 * HOUR));
    await turn(manager, key, "third");
    expect(runs(claude)).toBe(2);
    expect(runs(codex)).toBe(3);

    // After it: back on the primary.
    vi.setSystemTime(new Date(START.getTime() + 4 * HOUR));
    await turn(manager, key, "fourth");
    expect(runs(claude)).toBe(3);
    expect(registry.getSession(id)!.engine).toBe("claude");
    expect(override(id)).toBeUndefined();
  }, 30_000);

  it("goes back to the primary on a web-dispatched turn too, whatever engine the dispatcher resolved", async () => {
    const reset = new Date(START.getTime() + HOUR);
    const { manager, claude, codex, cfg } = harness([limitedUntil(reset), answer("claude is back", "claude-thread-2")]);
    const id = await turn(manager, "stub:expiry-web", "first");
    expect(registry.getSession(id)!.engine).toBe("codex");

    vi.setSystemTime(new Date(START.getTime() + 2 * HOUR));
    // A Todo wake, a delegation into a live session or a send_to_session resolve
    // the engine from the row as it stood — still codex — and dispatch with it.
    const stale = registry.getSession(id)!;
    registry.insertMessage(id, "user", "second");
    dispatchWebSessionRun(stale, "second", codex as never, apiContext(manager, cfg) as never);
    await eventually(() => runs(claude) === 2 && settled(id));
    expect(runs(codex)).toBe(1);
    expect(registry.getSession(id)!.engine).toBe("claude");
    expect(override(id)).toBeUndefined();
  }, 30_000);
});

describe("a new session started while the primary is out of allowance", () => {
  it("starts on the fallback with the primary's reopening recorded, and goes back to the primary after it", async () => {
    const reset = new Date(START.getTime() + HOUR);
    // An earlier session's limit is what put the primary's allowance on record.
    const { manager, claude, codex } = harness([limitedUntil(reset), answer("claude answer", "claude-thread")]);
    await turn(manager, "stub:expiry-earlier", "earlier");
    expect(readEngineHealth().claude?.state).toBe("exhausted");
    const claudeRunsBefore = runs(claude);

    const key = "stub:expiry-born-on-fallback";
    const id = await turn(manager, key, "first");
    expect(runs(claude)).toBe(claudeRunsBefore);
    expect(registry.getSession(id)!.engine).toBe("codex");
    expect(override(id)).toMatchObject({ originalEngine: "claude", originalModel: "opus", originalEngineSessionId: null });
    expect(Date.parse(String(override(id)!.until))).toBe(reset.getTime());

    vi.setSystemTime(new Date(START.getTime() + 2 * HOUR));
    await turn(manager, key, "second");
    expect(runs(claude)).toBe(claudeRunsBefore + 1);
    const back = registry.getSession(id)!;
    expect(back.engine).toBe("claude");
    expect(back.model).toBe("opus");
    expect(override(id)).toBeUndefined();
    expect(runs(codex)).toBe(2);
  }, 30_000);

  it("starts on the primary when it is created after the reset", async () => {
    const reset = new Date(START.getTime() + HOUR);
    const { manager, claude } = harness([limitedUntil(reset), answer("claude answer", "claude-thread")]);
    await turn(manager, "stub:expiry-earlier-2", "earlier");
    expect(readEngineHealth().claude?.state).toBe("exhausted");

    vi.setSystemTime(new Date(START.getTime() + 2 * HOUR));
    const id = await turn(manager, "stub:expiry-after-reset", "first");
    expect(registry.getSession(id)!.engine).toBe("claude");
    expect(registry.getSession(id)!.model).toBe("opus");
    expect(override(id)).toBeUndefined();
    expect(runs(claude)).toBe(2);
  }, 30_000);

  it("is handed the same expiry on the web, spawn and Todo paths", () => {
    const reset = new Date(START.getTime() + HOUR);
    fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify({
      claude: { state: "exhausted", until: reset.toISOString(), recheckAt: reset.toISOString(), reason: "quota window spent" },
    }));

    const selection = validateNewSessionSelection(config(), {}, { engine: "claude", model: "opus" });
    expect(selection).toMatchObject({ ok: true, engine: "codex", reroute: { from: "claude", model: "opus" } });
    expect(selection.reroute!.until.getTime()).toBe(reset.getTime());

    const meta = reroutedSessionMeta(selection.reroute, { kept: true })!;
    expect(meta).toEqual({
      kept: true,
      engineOverride: {
        originalEngine: "claude",
        originalEngineSessionId: null,
        originalModel: "opus",
        until: reset.toISOString(),
        syncSince: START.toISOString(),
      },
    });
  });

  it("is not rerouted, and carries no expiry, while the primary is healthy", () => {
    const selection = validateNewSessionSelection(config(), {}, { engine: "claude", model: "opus" });
    expect(selection).toEqual({ ok: true, engine: "claude", model: "opus", effortLevel: undefined });
    expect(reroutedSessionMeta(selection.reroute)).toBeUndefined();
  });
});
