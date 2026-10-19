import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, JinnConfig } from "../../shared/types.js";
import { baseConfig, call, loadApi, makeParent, resetFallbackFixture, setConfig, unloadApi } from "./session-fallback-api-harness.js";

/**
 * What the dashboard reads after a turn walked its chain: `GET /api/sessions/:id` reports the hops
 * (newest first), the target that served the turn, where the session stands and what a next limit
 * would do, from what the runtime persisted.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../shared/effort-wait.js", () => ({ awaitEffortLevels: async () => {} }));

beforeAll(loadApi);
afterAll(unloadApi);
beforeEach(resetFallbackFixture);

const limited = (): EngineResult => ({ sessionId: "", result: "", error: "429 Too Many Requests", rateLimit: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 } });

describe("GET /api/sessions/:id after a walked turn", () => {
  it("reports the hops, who served, the position and the next link under fallback.chain", async () => {
    setConfig({
      ...baseConfig,
      engines: {
        ...baseConfig.engines,
        claude: { bin: "claude", model: "opus", fallback: [{ engine: "codex", model: "gpt-5.6-sol" }, { engine: "codex", model: "gpt-mapped" }] },
      },
    } as unknown as JinnConfig);
    const { handleRateLimit } = await import("../../sessions/rate-limit-handler.js");
    const registry = await import("../../sessions/registry.js");
    const session = makeParent(null);
    const started = registry.beginSessionAttempt(session.id)!;
    const ran: Array<string | undefined> = [];
    const codex = { name: "codex", async run(opts: { model?: string }) { ran.push(opts.model); return opts.model === "gpt-mapped" ? { sessionId: "c1", result: "done" } : limited(); } } as unknown as Engine;
    const claude = { name: "claude", async run() { return limited(); } } as unknown as Engine;

    const outcome = await handleRateLimit({
      session: registry.getSession(session.id)!, attemptToken: started.attemptToken!, prompt: "go", engineConfig: { model: "opus" },
      config: (await import("./session-fallback-api-harness.js")).config, engines: new Map([["claude", claude], ["codex", codex]]), engine: claude,
      rateLimit: {}, originalResult: limited(), hooks: {},
    });
    expect(outcome.kind).toBe("fallback");
    expect(ran).toEqual(["gpt-5.6-sol", "gpt-mapped"]);

    const got = await call("GET", `/api/sessions/${session.id}`);
    expect(got.status).toBe(200);
    const chain = got.body.fallback.chain;
    expect(chain.servedBy).toBe("codex||gpt-mapped");
    expect(chain.position).toBe(2);
    expect(chain.next).toBeNull();
    expect(chain.links.map((link: { key: string }) => link.key)).toEqual(["claude||opus", "codex||gpt-5.6-sol", "codex||gpt-mapped"]);
    expect(chain.hops.map((hop: { from: string; to: string; reason: string }) => [hop.from, hop.to, hop.reason])).toEqual([
      ["codex||gpt-5.6-sol", "codex||gpt-mapped", "rate-limit"],
      ["claude||opus", "codex||gpt-5.6-sol", "rate-limit"],
    ]);
    // The same facts are on the session's transport meta, as the contract names them.
    expect(got.body.transportMeta.fallbackServedBy).toMatchObject({ key: "codex||gpt-mapped" });
    expect(got.body.transportMeta.fallbackRun).toMatchObject({ position: 2 });
  });
});
