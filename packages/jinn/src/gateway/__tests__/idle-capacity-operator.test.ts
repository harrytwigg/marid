import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadModules, modules } from "./idle-capacity-harness.js";

/**
 * which sessions in the registry count as the operator's own, read
 * off real rows rather than a hand-built shape, so the rule and the columns
 * it depends on cannot drift apart unnoticed.
 */

type Registry = typeof import("../../sessions/registry.js");
type Operator = typeof import("../idle-capacity-operator.js");
let registry: Registry;
let operator: Operator;

beforeAll(async () => {
  await loadModules();
  registry = await import("../../sessions/registry.js");
  operator = await import("../idle-capacity-operator.js");
});

afterEach(() => {
  modules.db.exec("DELETE FROM sessions");
});

const at = (iso: string): string => new Date(iso).toISOString();

function session(opts: Partial<Parameters<Registry["createSession"]>[0]> & { lastActivity: string }) {
  const created = registry.createSession({ engine: "claude", source: "web", sourceRef: `k-${Math.random()}`, ...opts });
  registry.updateSession(created.id, { lastActivity: opts.lastActivity });
  return registry.getSession(created.id)!;
}

describe("operatorDrivenSession", () => {
  it("counts top-level dashboard and connector chats, employee or not", () => {
    const coo = session({ lastActivity: at("2026-09-20T09:50:00Z") });
    const telegram = session({ source: "telegram", connector: "telegram", employee: "pa", lastActivity: at("2026-09-20T09:40:00Z") });
    expect(operator.operatorDrivenSession(coo)).toBe(true);
    expect(operator.operatorDrivenSession(telegram)).toBe(true);
  });

  it("does not count children, cron, Workflow or system-employee sessions", () => {
    const parent = session({ lastActivity: at("2026-09-20T09:00:00Z") });
    const child = session({ parentSessionId: parent.id, employee: "senior-developer", lastActivity: at("2026-09-20T09:59:00Z") });
    const cron = session({ source: "cron", lastActivity: at("2026-09-20T09:59:00Z") });
    const workflow = session({ source: "workflow", lastActivity: at("2026-09-20T09:59:00Z") });
    const dispatcher = session({ employee: "todo-dispatcher", sessionKey: "todo-dispatcher:JIN-1:x", lastActivity: at("2026-09-20T09:59:00Z") });
    for (const s of [child, cron, workflow, dispatcher]) expect(operator.operatorDrivenSession(s)).toBe(false);
    // The newest activity over the operator's sessions is the parent's, not the busier children's.
    expect(operator.newestOperatorSessionActivity(registry.listSessions())).toBe(Date.parse("2026-09-20T09:00:00Z"));
  });

  it("is undefined with no operator-driven session at all", () => {
    session({ source: "cron", lastActivity: at("2026-09-20T09:59:00Z") });
    expect(operator.newestOperatorSessionActivity(registry.listSessions())).toBeUndefined();
  });
});
