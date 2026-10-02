import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). Keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-reconcile-settle-"));
process.env.JINN_HOME = tmp;

type Reconcile = typeof import("../reconcile.js");
type SessionStatus = "idle" | "error" | "interrupted";

let store: typeof import("../store.js");
let reconcile: Reconcile;
let db: import("better-sqlite3").Database;

const OUTCOME = { idle: "succeeded", error: "failed", interrupted: "interrupted" } as const;

/** Newest-first receipts, as `listSessionsByWorkItem` returns them. */
function derive(current: Parameters<Reconcile["deriveWorkItemStatus"]>[0], statuses: SessionStatus[], autoClose?: boolean) {
  const attempts = statuses.map((status) => ({ status, outcome: OUTCOME[status] }));
  return reconcile.deriveWorkItemStatus(current, attempts, undefined, { autoClose });
}

beforeAll(async () => {
  store = await import("../store.js");
  reconcile = await import("../reconcile.js");
  db = (await import("../../shared/db.js")).initDb();
});

/* a run that ends cleanly is not the work finishing. Only an auto-closing (cron)
 * item, which has nobody to declare a fire finished, reads a settle as completion. */
describe("deriveWorkItemStatus — a clean settle", () => {
  it.each([undefined, false] as const)("never derives in_review for a reviewed item (autoClose %s)", (autoClose) => {
    expect(derive("executing", ["idle"], autoClose)).toBe("executing");
    expect(derive("executing", ["idle", "idle"], autoClose)).toBe("executing");
    expect(derive("executing", ["idle", "interrupted"], autoClose)).toBe("executing");
    // A clean retry still clears the transient block an older failure left.
    expect(derive("blocked", ["idle", "error"], autoClose)).toBe("executing");
    // Somebody put it in the queue after that attempt ran; a receipt does not undo that.
    expect(derive("backlog", ["idle"], autoClose)).toBe("backlog");
  });

  it("derives in_review for an auto-closing item, whatever it settled from", () => {
    expect(derive("backlog", ["idle"], true)).toBe("in_review");
    expect(derive("blocked", ["idle", "error"], true)).toBe("in_review");
    expect(derive("executing", ["idle", "interrupted"], true)).toBe("in_review");
    // Never done from derivation alone — the TRUST hook decides that.
    expect(derive("executing", ["idle", "idle"], true)).toBe("in_review");
  });

  it("leaves failure derivation unchanged either way", () => {
    for (const autoClose of [undefined, true, false] as const) {
      expect(derive("executing", ["error", "idle"], autoClose)).toBe("blocked");
      expect(derive("executing", ["interrupted"], autoClose)).toBe("blocked");
    }
  });
});

describe("reconcileWorkItem — auto-close comes from the item's provenance alone", () => {
  function settled(title: string, source: "delegation" | "cron" | "human") {
    const item = store.createWorkItem({ title, status: "executing", source, ...(source === "human" ? {} : { sourceRef: `${source}:${title}` }) });
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, attempt_outcome, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'web', ?, 'idle', 'succeeded', ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
    ).run(`s-${item.id}`, `settle:${item.id}`, item.id);
    return item.id;
  }

  it("holds a delegation in executing", () => {
    expect(reconcile.reconcileWorkItem(settled("delegated", "delegation"))?.item.status).toBe("executing");
  });

  it("holds an operator-created Todo in executing", () => {
    expect(reconcile.reconcileWorkItem(settled("by hand", "human"))?.item.status).toBe("executing");
  });

  it("closes a cron fire", () => {
    expect(reconcile.reconcileWorkItem(settled("cron fire", "cron"))?.item.status).toBe("done");
  });
});
