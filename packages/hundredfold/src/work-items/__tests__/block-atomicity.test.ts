import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry DB — off the live DB. Set BEFORE importing the store.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-wi-block-atomic-"));
process.env.HUNDREDFOLD_HOME = tmp;

// The block counter, the status write, and the audit event are one decision, so
// they have to be one transaction: a counter that survives a failed transition
// escalates a Todo on a block that never happened. We fail the AUDIT write, the
// last step, and assert the counter row rolled back with it. `vi.hoisted` shares
// a toggle with the hoisted mock.
const inject = vi.hoisted(() => ({ failEvent: false }));
vi.mock("../store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store.js")>();
  return {
    ...actual,
    appendWorkItemEvent: (...args: Parameters<typeof actual.appendWorkItemEvent>) => {
      if (inject.failEvent) throw new Error("injected audit-write failure");
      return actual.appendWorkItemEvent(...args);
    },
  };
});

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

describe("block record atomicity", () => {
  it("leaves no counter row behind when the transition throws", () => {
    const item = store.createWorkItem({ title: "atomic block", status: "executing", assignee: "platform-worker" });

    inject.failEvent = true;
    expect(() => tr.transition(item.id, "blocked", "session:agent-1", { agent: true, blockKind: "capability" }))
      .toThrow("injected audit-write failure");
    inject.failEvent = false;

    expect(blocks.readBlockRecord(db, item.id)).toBeUndefined();
    expect(store.getWorkItem(item.id)?.status).toBe("executing");
    expect(store.listWorkItemEvents(item.id).map((e) => e.kind)).toEqual(["created"]);

    // And the block still counts from zero once the fault clears — the failed
    // attempt left nothing to inherit.
    tr.transition(item.id, "blocked", "session:agent-1", { agent: true, blockKind: "capability" });
    expect(blocks.readBlockRecord(db, item.id)).toMatchObject({ kind: "capability", recurrences: 0 });
  });
});
