import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  EMPLOYEE,
  apiContext,
  connectorMessage,
  connectorStub,
  createTestHome,
  engineResult,
  eventually,
  postSession,
  rateLimitedResult,
  scriptedEngine,
  testConfig,
} from "./helpers/turn-parity-harness.js";
import { applyLegacyFallbackMigration } from "../../shared/engine-fallback.js";
import type { JinnConfig } from "../../shared/types.js";

/**
 * ICI-714 — the two session runners each carried their own completion sequence,
 * and they drifted. The connector runner guarded rate-limit accounting behind
 * `if (cost || numTurns)`, so a recovered turn reporting neither recorded
 * nothing at all, while the web runner recorded it unconditionally. Employee
 * budget caps are enforced from SUM(total_cost), so the two paths disagreed
 * about what a session had spent.
 *
 * Both paths now settle through settleTurn. These drive the same three terminal
 * classes down both and demand identical totals.
 */

createTestHome("jinn-turn-parity-");
const dbModule = await import("../../shared/db.js");

let registry: typeof import("../registry.js");
let api: typeof import("../../gateway/api.js");
let ManagerClass: typeof import("../manager.js").SessionManager;

beforeAll(async () => {
  [registry, api, { SessionManager: ManagerClass }] = await Promise.all([
    import("../registry.js"),
    import("../../gateway/api.js"),
    import("../manager.js"),
  ]);
  dbModule.initDb();
});

beforeEach(() => {
  dbModule.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

const employee = { name: EMPLOYEE, engine: "claude", persona: "Turn parity fixture" };

/** A turn is done only once it carries a terminal status — `waiting` is mid-turn. */
function hasSettled(id: string): boolean {
  const status = registry.getSession(id)?.status;
  return status === "idle" || status === "error" || status === "interrupted";
}

function totals(id: string): { cost: number; turns: number } {
  return dbModule.initDb()
    .prepare("SELECT total_cost AS cost, total_turns AS turns FROM sessions WHERE id = ?")
    .get(id) as { cost: number; turns: number };
}

/** Build a manager over a scripted claude engine plus a codex fallback. */
function harness(config: JinnConfig, claudeScript: ReturnType<typeof engineResult>[], codexScript = [engineResult({ result: "fallback answer" })]) {
  const claude = scriptedEngine("claude", claudeScript);
  const codex = scriptedEngine("codex", codexScript);
  const manager = new ManagerClass(
    config,
    new Map([["claude", claude as never], ["codex", codex as never]]),
    "parity-boot",
  );
  return { manager, claude, codex };
}

/** Run one turn down the connector path and return its accumulated totals. */
async function runConnectorTurn(config: JinnConfig, claudeScript: ReturnType<typeof engineResult>[], codexScript?: ReturnType<typeof engineResult>[]) {
  const { manager } = harness(config, claudeScript, codexScript);
  const connector = connectorStub();
  const key = `stub:parity-${Math.random().toString(16).slice(2)}`;
  const routed = await manager.route(connectorMessage(key, "probe"), connector, { employee: employee as never });
  const id = routed!.sessionId;
  await eventually(() => hasSettled(id), 40_000);
  return { id, totals: totals(id), session: registry.getSession(id)! };
}

/** Run one turn down the web path and return its accumulated totals. */
async function runWebTurn(config: JinnConfig, claudeScript: ReturnType<typeof engineResult>[], codexScript?: ReturnType<typeof engineResult>[]) {
  const { manager } = harness(config, claudeScript, codexScript);
  const id = await postSession(api, apiContext(manager, config), { prompt: "probe", employee: EMPLOYEE });
  await eventually(() => hasSettled(id), 40_000);
  return { id, totals: totals(id), session: registry.getSession(id)! };
}

describe("both runners account for every terminal class identically", () => {
  it("a normal completion records the engine's reported cost and turns on both paths", async () => {
    const script = [engineResult({ result: "done", sessionId: "native-1", cost: 0.25, numTurns: 3 })];
    const connector = await runConnectorTurn(testConfig(), script);
    const web = await runWebTurn(testConfig(), script);

    expect(connector.totals).toEqual({ cost: 0.25, turns: 3 });
    expect(web.totals).toEqual(connector.totals);
  });

  it("a rate-limit fallback records the recovered turn on both paths", async () => {
    // The fallback engine answers but reports neither cost nor numTurns — the
    // exact shape the connector runner's `if (cost || numTurns)` guard dropped.
    const config = testConfig({ sessions: { rateLimitStrategy: "fallback" } } as Partial<JinnConfig>);
    applyLegacyFallbackMigration(config, () => {});
    const limited = [rateLimitedResult(-60)];
    const recovered = [engineResult({ result: "fallback answer", sessionId: "native-fb" })];

    const connector = await runConnectorTurn(config, limited, recovered);
    const web = await runWebTurn(config, limited, recovered);

    expect(connector.totals).toEqual({ cost: 0, turns: 1 });
    expect(web.totals).toEqual(connector.totals);
  });

  it("a rate-limit retry records the resumed turn on both paths", async () => {
    // resetsAt 60s in the past keeps the deadline (resetsAt + 30min) live while
    // the first retry fires after the 10s floor.
    const limitedThenOk = () => [
      rateLimitedResult(-60),
      engineResult({ result: "resumed answer", sessionId: "native-retry" }),
    ];

    const connector = await runConnectorTurn(testConfig(), limitedThenOk());
    const web = await runWebTurn(testConfig(), limitedThenOk());

    expect(connector.totals).toEqual({ cost: 0, turns: 1 });
    expect(web.totals).toEqual(connector.totals);
    expect(connector.session.status).toBe("idle");
    expect(web.session.status).toBe("idle");
  }, 60_000);
});
