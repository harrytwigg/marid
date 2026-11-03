import { describe, expect, it } from "vitest";
import {
  connectorMessage, connectorStub, createTestHome, engineResult, eventually, scriptedEngine, testConfig,
} from "./helpers/turn-parity-harness.js";

/**
 * A message that arrives in a chat connector's own conversation is the one way
 * to start a turn on that chat, so the turn it starts is stamped as the
 * operator's: a connector coordinator keeps closing Todos on the operator's
 * word. Nothing else starts a turn there with the stamp (the gateway's message
 * route, where a send from another session or a delegation brief lands, never
 * sets it).
 */

createTestHome("jinn-connector-operator-turn-");
const registry = await import("../registry.js");
(await import("../../shared/db.js")).initDb();
const { SessionManager } = await import("../manager.js");

describe("a turn a connector message starts", () => {
  it("is the operator's turn on the coordinator chat, while it runs", async () => {
    const engine = scriptedEngine("claude", [engineResult({ result: "ok", sessionId: "thread-1" })]);
    const seen: Array<{ stamped: boolean; coordinatorTurn: boolean }> = [];
    const run = engine.run;
    engine.run = async (opts) => {
      const row = registry.getSessionBySessionKey("stub:operator-turn")!;
      seen.push({ stamped: row.attemptOperatorTurn === true, coordinatorTurn: registry.isOperatorCoordinatorTurn(row) });
      return run(opts);
    };
    const manager = new SessionManager(testConfig(), new Map([["claude", engine as never]]), "connector-turn-boot");

    const routed = await manager.route(connectorMessage("stub:operator-turn", "close it"), connectorStub());

    await eventually(() => registry.getSession(routed!.sessionId)?.status === "idle");
    expect(seen).toEqual([{ stamped: true, coordinatorTurn: true }]);
    // Once the turn is over the chat is no longer on the operator's word.
    expect(registry.isOperatorCoordinatorTurn(registry.getSession(routed!.sessionId)!)).toBe(false);
  });
});
