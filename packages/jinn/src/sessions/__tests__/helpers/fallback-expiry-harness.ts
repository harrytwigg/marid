import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import {
  connectorMessage,
  connectorStub,
  createTestHome,
  engineResult,
  eventually,
  scriptedEngine,
  testConfig,
  type ScriptedEngine,
} from "./turn-parity-harness.js";
import type { EngineResult, JinnConfig } from "../../../shared/types.js";

/**
 * Drives connector turns through a real SessionManager over a scripted claude
 * primary and a codex fallback, with only the clock faked, so a suite can move
 * time past a usage limit's reset and see which engine the next turn runs on.
 */

export const START = new Date("2026-10-14T10:00:00.000Z");
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

const employee = { name: "a-worker", engine: "claude", model: "opus", persona: "Fallback expiry fixture" };

/** Claude is the primary, codex its fallback. */
export function fallbackConfig(): JinnConfig {
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
export function limitedUntil(reset: Date): EngineResult {
  return engineResult({
    error: "429 usage limit reached",
    rateLimit: { status: "rejected", resetsAt: Math.floor(reset.getTime() / 1000) },
  } as Partial<EngineResult>);
}

export const answer = (text: string, sessionId: string) => engineResult({ result: text, sessionId });

/** A scripted engine that also keeps every prompt it was handed. */
function recording(name: string, script: EngineResult[]): ScriptedEngine & { prompts: string[] } {
  const engine = scriptedEngine(name, script) as ScriptedEngine & { prompts: string[] };
  const run = engine.run;
  engine.prompts = [];
  engine.run = async (opts) => {
    engine.prompts.push(String((opts as { prompt?: unknown }).prompt ?? ""));
    return run(opts);
  };
  return engine;
}

/** Engine runs, read after the turn so a lagging settle cannot hide one. */
export function runs(engine: ScriptedEngine): number {
  return engine.runs;
}

/** A throwaway home and the modules bound to it; call once, at the top of a suite. */
export async function fallbackExpiryHarness(prefix: string) {
  const home = createTestHome(prefix);
  const healthPath = path.join(home, "tmp", "engine-health.json");
  const dbModule = await import("../../../shared/db.js");
  const registry = await import("../../registry.js");
  const { SessionManager } = await import("../../manager.js");
  dbModule.initDb();

  /** Empty tables, no health on record, and the clock at START. */
  function reset(): void {
    dbModule.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
    fs.rmSync(healthPath, { force: true });
    // Only the clock is faked: turns still settle on real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  }

  function harness(claudeScript: EngineResult[], codexScript: EngineResult[] = [answer("codex answer", "codex-thread")]) {
    const claude = recording("claude", claudeScript);
    const codex = scriptedEngine("codex", codexScript);
    const cfg = fallbackConfig();
    const manager = new SessionManager(cfg, new Map([["claude", claude as never], ["codex", codex as never]]), "expiry-boot");
    return { manager, claude, codex, cfg };
  }

  function settled(id: string): boolean {
    const status = registry.getSession(id)?.status;
    return status === "idle" || status === "error" || status === "interrupted";
  }

  function answers(id: string): number {
    return registry.getMessages(id).filter((m) => m.role === "assistant").length;
  }

  /** One connector turn on `key`; resolves once it has been answered and settled. */
  async function turn(manager: InstanceType<typeof SessionManager>, key: string, text: string): Promise<string> {
    const existing = registry.getSessionBySessionKey(key);
    const before = existing ? answers(existing.id) : 0;
    const routed = await manager.route(connectorMessage(key, text), connectorStub(), { employee: employee as never });
    const id = routed!.sessionId;
    await eventually(() => answers(id) > before && settled(id));
    return id;
  }

  function override(id: string): Record<string, unknown> | undefined {
    return (registry.getSession(id)!.transportMeta as Record<string, Record<string, unknown>> | null)?.engineOverride;
  }

  return { healthPath, registry, reset, harness, settled, turn, override };
}
