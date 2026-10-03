import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnRun, TurnSurface } from "../turn/types.js";
import type { EngineAttempt } from "../turn/engine-run.js";

/**
 * An opencode server-mode turn that a provider error stopped partway — after
 * an earlier step had said something ("Let me verify x before y.") — was
 * settled as completed, with no lastError: the narration passed for the
 * answer. This drives the real engine against the fake opencode server and
 * settles its result the way the gateway does, so what is asserted is the
 * session row an operator (or a cron's run log) actually sees.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-opencode-midturn-error-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { settleAnsweredTurn } = await import("../turn/settle.js");
const { OpencodeEngine } = await import("../../engines/opencode.js");
const { OpencodeServerPool } = await import("../../engines/opencode-server.js");
const { PtyLifecycleManager } = await import("../../engines/pty-lifecycle.js");

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engines", "__tests__", "fixtures", "fake-opencode.mjs");

const silentSurface: TurnSurface = {
  started: async () => {},
  delta: () => {},
  notice: async () => {},
  reply: async () => {},
  waiting: async () => {},
  settled: async () => {},
};

const verdict = { quietPreempted: false, streamedThrough: 0, superseded: false, enginePromptRead: true };

let pool: InstanceType<typeof OpencodeServerPool>;
let engine: InstanceType<typeof OpencodeEngine>;

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  pool = new OpencodeServerPool(new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false }), { limits: () => ({}), bin: () => FAKE });
  engine = new OpencodeEngine({ mode: () => "server", servers: pool });
});

afterEach(async () => {
  engine.killAll();
  await pool.stopAll();
});

async function settle(prompt: string) {
  const created = reg.createSession({ engine: "opencode", source: "cron", sourceRef: `cron:test:${Math.random()}`, model: "opencode-go/mock-model" });
  const session = reg.beginSessionAttempt(created.id)!;
  const result = await engine.run({ prompt, cwd: tmp, sessionId: session.id, bin: FAKE, model: "opencode-go/mock-model" });
  const run = {
    input: { session, attemptToken: session.attemptToken!, prompt, attachments: [], config: { engines: {} } },
    plan: { ok: true, engineName: "opencode" },
    surface: silentSurface,
    heartbeat: { stop: () => {} },
    partialStream: { write: () => {} },
    turnStartedAt: Date.now(),
    terminalFields: () => ({}),
  } as unknown as TurnRun;
  const attempt = { result, fingerprint: "fp", contextRefresh: undefined, systemPrompt: "" } as EngineAttempt;
  await settleAnsweredTurn(run, attempt, "opencode-go/mock-model", verdict);
  return reg.getSession(session.id);
}

describe("an opencode server-mode turn stopped partway by a provider error", { timeout: 20_000 }, () => {
  it.each(["err,idle,msg,idle", "msg,idle,err"])("is settled failed, with the provider's error as lastError (%s)", async (order) => {
    expect(await settle(`MIDFAIL ORDER=${order}`)).toMatchObject({
      status: "error",
      attemptOutcome: "failed",
      lastError: 'APIError: Bad Request: {"model":"mock-model"}',
    });
  });

  it("a turn that finishes is still settled as completed", async () => {
    expect(await settle("MULTISTEP work")).toMatchObject({ status: "idle", attemptOutcome: "succeeded", lastError: null });
  });
});

describe("an opencode server-mode turn whose transport was lost mid-turn", { timeout: 20_000 }, () => {
  it("is settled failed, not completed, so the work is not silently dropped", async () => {
    // The host dropped after a step had narrated. The stream loss is the
    // turn's outcome: settling it completed with lastError null is what let a
    // stopped turn pass for a finished one and lose its work unnoticed.
    expect(await settle("DROPSTREAM work")).toMatchObject({
      status: "error",
      attemptOutcome: "failed",
      lastError: "the opencode server closed the event stream mid-turn",
    });
  });
});
