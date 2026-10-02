import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-block-kinds-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
type Blocks = typeof import("../blocks.js");

let store: Store;
let tr: Transitions;
let blocks: Blocks;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  tr = await import("../transitions.js");
  blocks = await import("../blocks.js");
  db = (await import("../../shared/db.js")).initDb();
});

const mk = (status: "backlog" | "executing", extra: Record<string, unknown> = {}) =>
  store.createWorkItem({ title: `t-${Math.random().toString(36).slice(2, 8)}`, status, ...extra });

const AGENT = "session:agent-1";

/** The agent lane, which is the lane every real blocker uses. */
const block = (id: string, kind?: Blocks["BLOCK_KINDS"][number]) =>
  tr.transition(id, "blocked", AGENT, { agent: true, ...(kind ? { blockKind: kind } : {}) });

const unblock = (id: string) => tr.transition(id, "executing", AGENT, { agent: true });

const record = (id: string) => blocks.readBlockRecord(db, id);

describe("typed block kinds — routing", () => {
  it("routes a dependency block back to the queue, not in front of a human", () => {
    // Always the backlog, owned or not: an owned Todo waits there with its assignee.
    const owned = mk("executing", { assignee: "platform-worker" });
    expect(block(owned.id, "dependency").item).toMatchObject({ status: "backlog", assignee: "platform-worker" });

    const unassigned = mk("executing");
    expect(block(unassigned.id, "dependency").item.status).toBe("backlog");
  });

  it.each(["needs_input", "capability", "transient"] as const)("parks a %s block in blocked", (kind) => {
    const wi = mk("executing", { assignee: "platform-worker" });
    expect(block(wi.id, kind).item.status).toBe("blocked");
    expect(record(wi.id)).toMatchObject({ kind, recurrences: 0 });
  });

  it("reads a kind-less block as needs_input, never as dependency", () => {
    const wi = mk("executing", { assignee: "platform-worker" });

    expect(block(wi.id).item.status).toBe("blocked");
    expect(record(wi.id)?.kind).toBe("needs_input");
  });
});

describe("the unblock-loop breaker", () => {
  it("counts a same-kind re-block across the unblock that cleared it", () => {
    const wi = mk("executing", { assignee: "platform-worker" });

    block(wi.id, "needs_input");
    expect(record(wi.id)).toMatchObject({ kind: "needs_input", recurrences: 0 });

    // The amnesia this guard exists to prevent: unblocking must not forget.
    unblock(wi.id);
    expect(record(wi.id)).toMatchObject({ kind: "needs_input", recurrences: 0 });

    expect(block(wi.id, "needs_input").item.status).toBe("blocked");
    expect(record(wi.id)).toMatchObject({ kind: "needs_input", recurrences: 1 });
  });

  it("escalates the third same-kind block instead of parking it again", () => {
    const wi = mk("executing", { assignee: "platform-worker" });

    block(wi.id, "capability");
    unblock(wi.id);
    block(wi.id, "capability");
    unblock(wi.id);
    const third = block(wi.id, "capability");

    expect(third.item.status).toBe("blocked");
    expect(third.escalated).toBe(true);
    const escalations = store.listWorkItemEvents(wi.id).filter((e) => e.kind === "escalated");
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ toStatus: "blocked" });
    expect(escalations[0].detail).toMatchObject({
      declared: true,
      reason: "block_loop_detected",
      blockKind: "capability",
      recurrences: 2,
    });
    expect(record(wi.id)).toMatchObject({ kind: "capability", recurrences: 2 });
  });

  it("treats a different kind as a new problem: the count resets and nothing escalates", () => {
    const wi = mk("executing", { assignee: "platform-worker" });

    block(wi.id, "transient");
    unblock(wi.id);
    block(wi.id, "transient");
    unblock(wi.id);
    const switched = block(wi.id, "needs_input");

    expect(switched.item.status).toBe("blocked");
    expect(switched.escalated).toBe(false);
    expect(record(wi.id)).toMatchObject({ kind: "needs_input", recurrences: 0 });
    expect(store.listWorkItemEvents(wi.id).some((e) => e.kind === "escalated")).toBe(false);
  });

  // transition()'s same-status shortcut returns before writing anything, and it
  // compares the REQUESTED status. A dependency block on an already-blocked Todo
  // requests `blocked` while routing to `backlog`, so the shortcut would swallow
  // both the move and the count — the breaker installed, and silent.
  it("does not let the same-status shortcut swallow a dependency block", () => {
    const wi = mk("executing", { assignee: "platform-worker" });
    tr.transition(wi.id, "blocked", AGENT, { agent: true, blockKind: "needs_input" });
    const events = store.listWorkItemEvents(wi.id).length;

    const routed = tr.transition(wi.id, "blocked", AGENT, { agent: true, blockKind: "dependency" });

    expect(routed.item.status).toBe("backlog");
    expect(store.listWorkItemEvents(wi.id)).toHaveLength(events + 1);
    expect(record(wi.id)).toMatchObject({ kind: "dependency", recurrences: 0 });
  });

  it("counts a block whose routed target is the status the Todo is already in", () => {
    const wi = mk("backlog", { assignee: "platform-worker" });

    const first = block(wi.id, "dependency");
    expect(first.item.status).toBe("backlog");
    expect(record(wi.id)).toMatchObject({ kind: "dependency", recurrences: 0 });
    expect(store.listWorkItemEvents(wi.id).at(-1)).toMatchObject({
      kind: "status_change",
      fromStatus: "backlog",
      toStatus: "backlog",
      actor: AGENT,
    });

    expect(block(wi.id, "dependency").item.status).toBe("backlog");
    expect(record(wi.id)).toMatchObject({ kind: "dependency", recurrences: 1 });

    const third = block(wi.id, "dependency");
    expect(third.item.status).toBe("blocked");
    expect(third.escalated).toBe(true);
    expect(record(wi.id)).toMatchObject({ recurrences: 2 });
  });
});

describe("what clears the record", () => {
  it("clears it on done, so a later block starts over", () => {
    const wi = mk("executing", { assignee: "platform-worker" });

    block(wi.id, "needs_input");
    unblock(wi.id);
    block(wi.id, "needs_input");
    expect(record(wi.id)).toMatchObject({ recurrences: 1 });

    tr.transition(wi.id, "done", "reviewer", { agent: true });
    expect(record(wi.id)).toBeUndefined();

    tr.transition(wi.id, "backlog", "operator", { human: true });
    block(wi.id, "needs_input");
    expect(record(wi.id)).toMatchObject({ kind: "needs_input", recurrences: 0 });
  });

  it("keeps it on cancelled — only a successful completion is the reset", () => {
    const wi = mk("executing", { assignee: "platform-worker" });

    block(wi.id, "transient");
    tr.transition(wi.id, "cancelled", "operator", { human: true });

    expect(record(wi.id)).toMatchObject({ kind: "transient", recurrences: 0 });
  });
});
