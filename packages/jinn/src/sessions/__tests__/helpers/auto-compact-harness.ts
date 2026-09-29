import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Engine, EngineResult, EngineRunOpts, JinnConfig, StreamDelta } from "../../../shared/types.js";
import type { TurnReceipt, TurnSurface } from "../../turn/types.js";

/**
 * Shared harness for the auto-compaction `runTurn` tests: an isolated DB, a
 * recording engine and surface, and a session that is long and cold on demand.
 * Import it AFTER the test file's own `vi.mock`s — it opens the registry.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-auto-compact-"));
process.env.JINN_HOME = tmp;
export const reg = await import("../../registry.js");
const { runTurn } = await import("../../turn/runner.js");
export const { supersedeRunningTurn, readUnseenInterruptedPrompts } = await import("../../turn/superseded.js");
export const { isAutoCompacting } = await import("../../auto-compaction.js");

export interface Recorded {
  events: string[];
  notices: string[];
  deltas: StreamDelta[];
  receipts: TurnReceipt[];
}

export function recordingSurface(): { surface: TurnSurface; seen: Recorded } {
  const seen: Recorded = { events: [], notices: [], deltas: [], receipts: [] };
  const surface: TurnSurface = {
    started: async () => { seen.events.push("started"); },
    delta: (d) => { seen.events.push(`delta:${d.type}`); seen.deltas.push(d); },
    notice: async (text) => { seen.events.push("notice"); seen.notices.push(text); },
    reply: async () => {},
    waiting: async () => {},
    settled: async (receipt) => { seen.events.push("settled"); seen.receipts.push(receipt); },
  };
  return { surface, seen };
}

interface Call { prompt: string; resumeSessionId?: string }

export function recordingEngine(name: string, behaviour: (opts: EngineRunOpts, call: number) => Promise<EngineResult>) {
  const calls: Call[] = [];
  const engine: Engine = {
    name,
    async run(opts) {
      calls.push({ prompt: opts.prompt, resumeSessionId: opts.resumeSessionId });
      return behaviour(opts, calls.length);
    },
  };
  return { engine, calls };
}

export function configWith(autoCompact: Record<string, unknown> | undefined, engine = "claude"): JinnConfig {
  return {
    gateway: {},
    engines: {
      default: "claude",
      claude: engine === "claude" && autoCompact ? { autoCompact } : {},
      opencode: { mode: "server", ...(engine === "opencode" && autoCompact ? { autoCompact } : {}) },
    },
    sessions: {},
  } as unknown as JinnConfig;
}

export const ENABLED = { enabled: true, cacheWindowSeconds: 300, minContextTokens: 50_000 };
export const MINUTE = 60_000;

/** A session with a conversation on `engine`, `contextTokens` in it, last
 *  touched `idleMs` ago. */
export function coldSession(engine: string, sourceRef: string, contextTokens: number, idleMs: number): string {
  const created = reg.createSession({ engine, source: "web", sourceRef, model: "opus" });
  reg.recordEngineSessionId(created.id, engine, `${engine}-thread-1`, {
    model: "opus",
    lastSyncedAt: new Date(Date.now() - idleMs).toISOString(),
  });
  reg.updateSession(created.id, { lastContextTokens: contextTokens });
  return created.id;
}

export async function runOne(engine: Engine, sessionId: string, prompt: string, surface: TurnSurface, config: JinnConfig): Promise<void> {
  const started = reg.beginSessionAttempt(sessionId)!;
  await runTurn({
    session: reg.getSession(sessionId)!,
    attemptToken: started.attemptToken!,
    prompt,
    attachments: [],
    config,
    engines: new Map([[engine.name, engine]]),
    gatewayBootId: "test-boot",
    connectorNames: [],
    channel: "web",
    user: "operator",
  }, surface);
}

export const answered = (sessionId: string, text = "done"): EngineResult => ({ sessionId, result: text, contextTokens: 3_000 });
