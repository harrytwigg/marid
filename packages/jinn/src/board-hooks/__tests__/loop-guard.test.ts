import { beforeAll, describe, expect, it } from "vitest";
import { useTempHome } from "./db-fixtures.js";

useTempHome("jinn-board-hooks-guard-");

type Guard = typeof import("../loop-guard.js");
type Runs = typeof import("../run-store.js");
type Registry = typeof import("../../sessions/registry.js");
let guard: Guard;
let runs: Runs;
let registry: Registry;
let db: ReturnType<typeof import("../../shared/db.js").initDb>;

beforeAll(async () => {
  guard = await import("../loop-guard.js");
  runs = await import("../run-store.js");
  registry = await import("../../sessions/registry.js");
  db = (await import("../../shared/db.js")).initDb();
});

/** A session a hook spawned, with the run row its fire left behind. */
function hookSession(fireId: string, chain: string[], parentSessionId?: string) {
  runs.insertRun({ fireId, hook: chain.at(-1)!, event: "todo.created", eventId: "wie_1", todoId: "PLA-1", action: "spawn", status: "running", payload: {}, chain });
  return registry.createSession({ engine: "claude", source: "hook", sourceRef: `hook:${fireId}`, employee: "worker", parentSessionId });
}

function ordinary(parentSessionId?: string) {
  return registry.createSession({ engine: "claude", source: "web", sourceRef: `web:${Math.random()}`, parentSessionId });
}

describe("eventChain", () => {
  it("is empty when nobody, or an ordinary session, acted", () => {
    expect(guard.eventChain(undefined)).toEqual([]);
    expect(guard.eventChain(ordinary().id)).toEqual([]);
    expect(guard.eventChain("no-such-session")).toEqual([]);
  });

  it("is the stored chain for a session a hook spawned", () => {
    const session = hookSession("bhf_direct", ["review"]);
    expect(guard.eventChain(session.id)).toEqual(["review"]);
  });

  it("finds a hook session among the ancestors of a descendant", () => {
    const root = hookSession("bhf_root", ["review", "merge"]);
    const child = ordinary(root.id);
    const grandchild = ordinary(child.id);
    expect(guard.eventChain(grandchild.id)).toEqual(["review", "merge"]);
  });

  it("stops walking after ten levels", () => {
    const root = hookSession("bhf_deep", ["deep"]);
    let tip = ordinary(root.id);
    for (let level = 0; level < 9; level += 1) tip = ordinary(tip.id);
    expect(guard.eventChain(tip.id)).toEqual([]);
    const nearer = ordinary(root.id);
    expect(guard.eventChain(nearer.id)).toEqual(["deep"]);
  });

  it("does not loop on a parent cycle", () => {
    const a = ordinary();
    const b = ordinary(a.id);
    db.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run(b.id, a.id);
    expect(registry.getSession(a.id)?.parentSessionId).toBe(b.id);
    expect(guard.eventChain(b.id)).toEqual([]);
  });
});

describe("suppressionReason", () => {
  it("lets a hook fire when it is not in the chain", () => {
    expect(guard.suppressionReason({ name: "a" }, [])).toBeNull();
    expect(guard.suppressionReason({ name: "a" }, ["b", "c"])).toBeNull();
  });

  it("suppresses a hook already in the chain unless it allows re-entry", () => {
    expect(guard.suppressionReason({ name: "a" }, ["b", "a"])).toMatch(/hook "a" is already in this event's chain \(b -> a\)/);
    expect(guard.suppressionReason({ name: "a", allowReentry: true }, ["b", "a"])).toBeNull();
  });

  it("suppresses every hook once the chain holds five, re-entry or not", () => {
    const full = ["a", "b", "c", "d", "e"];
    expect(guard.suppressionReason({ name: "z" }, full)).toMatch(/holds 5 hooks.*limit is 5/);
    expect(guard.suppressionReason({ name: "a", allowReentry: true }, full)).toMatch(/limit is 5/);
    expect(guard.suppressionReason({ name: "z" }, full.slice(0, 4))).toBeNull();
  });
});
