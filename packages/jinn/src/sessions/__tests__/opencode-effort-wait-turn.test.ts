import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, EngineRunOpts, JinnConfig, ModelInfo } from "../../shared/types.js";
import type { OpencodeDiscovery } from "../../shared/opencode-discovery.js";
import type { TurnSurface } from "../turn/types.js";

/**
 * A turn that reaches opencode while its model discovery is still waiting on
 * the `--verbose` details: through `runTurn`, the effort the session chose must
 * reach the engine, both when opencode is the session's own engine and when it
 * takes the turn as a rate-limit substitute. Resolved before the levels land,
 * the effort was dropped for want of them.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
// The login gates read this machine's real Claude state; neither is under test.
vi.mock("../../shared/claude-profile-signin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-profile-signin.js")>()),
  verifyLocalClaudeProfile: () => undefined,
}));
vi.mock("../claude-auth-watch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude-auth-watch.js")>()),
  refuseClaudeLaunch: () => undefined,
  observeClaudeTurnOutcome: () => {},
}));
const discoveries = vi.hoisted(() => [] as Array<() => OpencodeDiscovery>);
vi.mock("../../shared/opencode-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/opencode-discovery.js")>()),
  discoverOpencodeModels: async () => (discoveries.shift() ?? (() => ({ models: [], detailed: false })))(),
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-opencode-effort-wait-"));
process.env.JINN_HOME = tmp;
// Discovery checks the binary itself (the mocked export does not reach calls
// inside models.ts), so it must exist whatever this machine has on PATH.
const opencodeBin = path.join(tmp, "opencode");
fs.writeFileSync(opencodeBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const reg = await import("../registry.js");
const { runTurn } = await import("../turn/runner.js");
const { refreshOpencodeModels } = await import("../../shared/models.js");

const config = {
  gateway: {},
  engines: { default: "opencode", claude: { model: "opus", fallback: ["opencode"] }, opencode: { bin: opencodeBin } },
  sessions: {},
} as unknown as JinnConfig;

const variants = (): ModelInfo[] => [{ id: "opencode/a", label: "a", supportsEffort: true, effortLevels: ["low", "high"] }];

/** Put discovery in its slow window: the plain list served, details on `land`. */
async function slowDiscovery(): Promise<(models: ModelInfo[]) => Promise<void>> {
  let resolve: (models: ModelInfo[] | undefined) => void = () => {};
  const details = new Promise<ModelInfo[] | undefined>((r) => (resolve = r));
  discoveries.push(() => ({ models: [{ id: "opencode/a", label: "a", supportsEffort: false, effortLevels: [] }], detailed: false, details }));
  await refreshOpencodeModels(config);
  return async (models) => {
    resolve(models);
    await new Promise((r) => setImmediate(r));
  };
}

function recordingEngine(name: string, answer: () => EngineResult) {
  const calls: EngineRunOpts[] = [];
  const engine: Engine = { name, async run(opts) { calls.push(opts); return answer(); } };
  return { engine, calls };
}

const surface: TurnSurface = {
  started: async () => {}, delta: () => {}, notice: async () => {}, reply: async () => {}, waiting: async () => {}, settled: async () => {},
};

function startTurn(sessionId: string, engines: Map<string, Engine>): Promise<void> {
  reg.insertMessage(sessionId, "user", "hello");
  const started = reg.beginSessionAttempt(sessionId)!;
  return runTurn({
    session: reg.getSession(sessionId)!, attemptToken: started.attemptToken!, prompt: "hello", attachments: [], config, engines,
    gatewayBootId: "test-boot", connectorNames: [], channel: "web", user: "operator",
  }, surface);
}

const tick = () => new Promise((r) => setTimeout(r, 50));

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

afterEach(async () => {
  await refreshOpencodeModels({ ...config, engines: { default: "claude" } } as unknown as JinnConfig);
  discoveries.length = 0;
});

describe("an opencode turn while the effort levels are still being discovered", () => {
  it("waits for them, then runs with the session's effort", async () => {
    const land = await slowDiscovery();
    const opencode = recordingEngine("opencode", () => ({ sessionId: "oc-1", result: "done" }));
    const session = reg.createSession({ engine: "opencode", source: "web", sourceRef: "web:effort-wait", model: "opencode/a", effortLevel: "high" });

    const turn = startTurn(session.id, new Map([["opencode", opencode.engine]]));
    await tick();
    expect(opencode.calls).toHaveLength(0);
    await land(variants());
    await turn;

    expect(opencode.calls).toHaveLength(1);
    expect(opencode.calls[0]!.effortLevel).toBe("high");
  });

  it("waits for them before handing a rate-limited turn to opencode, so the substitute runs with the effort", async () => {
    const land = await slowDiscovery();
    const claude = recordingEngine("claude", () => ({
      sessionId: "cl-1", result: "", error: "You've hit your weekly limit",
      rateLimit: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 },
    }));
    const opencode = recordingEngine("opencode", () => ({ sessionId: "oc-1", result: "done" }));
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:effort-wait-fallback", model: "opus", effortLevel: "high" });

    const turn = startTurn(session.id, new Map([["claude", claude.engine], ["opencode", opencode.engine]]));
    await tick();
    expect(claude.calls).toHaveLength(1);
    expect(opencode.calls).toHaveLength(0);
    await land(variants());
    await turn;

    expect(opencode.calls).toHaveLength(1);
    expect(opencode.calls[0]!.effortLevel).toBe("high");
  });
});
