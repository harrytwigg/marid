import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). Keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-reconcile-settle-"));
process.env.JINN_HOME = tmp;

type Reconcile = typeof import("../reconcile.js");
type VerifyMode = NonNullable<Parameters<Reconcile["deriveWorkItemStatus"]>[3]>["verifyMode"];
type SessionStatus = "idle" | "error" | "interrupted";

let store: typeof import("../store.js");
let reconcile: Reconcile;
let db: import("better-sqlite3").Database;

const OUTCOME = { idle: "succeeded", error: "failed", interrupted: "interrupted" } as const;

/** Newest-first receipts, as `listSessionsByWorkItem` returns them. */
function derive(current: Parameters<Reconcile["deriveWorkItemStatus"]>[0], statuses: SessionStatus[], verifyMode?: VerifyMode) {
  const attempts = statuses.map((status) => ({ status, outcome: OUTCOME[status] }));
  return reconcile.deriveWorkItemStatus(current, attempts, undefined, { verifyMode });
}

beforeAll(async () => {
  store = await import("../store.js");
  reconcile = await import("../reconcile.js");
  db = (await import("../../shared/db.js")).initDb();
});

/* a run that ends cleanly is not the work finishing. Only the trust tier,
 * which has nobody to declare a fire finished, reads a settle as completion. */
describe("deriveWorkItemStatus — a clean settle", () => {
  it.each([undefined, "verify", "thorough"] as const)("never derives in_review for a reviewed tier (%s)", (verifyMode) => {
    expect(derive("executing", ["idle"], verifyMode)).toBe("executing");
    expect(derive("executing", ["idle", "idle"], verifyMode)).toBe("executing");
    expect(derive("executing", ["idle", "interrupted"], verifyMode)).toBe("executing");
    // A clean retry still clears the transient block an older failure left.
    expect(derive("blocked", ["idle", "error"], verifyMode)).toBe("executing");
    // Somebody put it in the queue after that attempt ran; a receipt does not undo that.
    expect(derive("backlog", ["idle"], verifyMode)).toBe("backlog");
    expect(derive("assigned", ["idle"], verifyMode)).toBe("assigned");
  });

  it("derives in_review for the trust tier, whatever it settled from", () => {
    expect(derive("backlog", ["idle"], "trust")).toBe("in_review");
    expect(derive("blocked", ["idle", "error"], "trust")).toBe("in_review");
    expect(derive("executing", ["idle", "interrupted"], "trust")).toBe("in_review");
    // Never done from derivation alone — the TRUST hook decides that.
    expect(derive("executing", ["idle", "idle"], "trust")).toBe("in_review");
  });

  it("leaves failure derivation unchanged on every tier", () => {
    for (const verifyMode of [undefined, "trust", "verify"] as const) {
      expect(derive("executing", ["error", "idle"], verifyMode)).toBe("blocked");
      expect(derive("executing", ["interrupted"], verifyMode)).toBe("blocked");
    }
  });
});

describe("reconcileWorkItem — the verify mode comes from the item's own policy", () => {
  function settled(title: string, source: "delegation" | "cron", mode?: "trust" | "verify") {
    const item = store.createWorkItem({ title, status: "executing", source, ...(mode ? { verifyPolicy: { mode } } : {}) });
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, attempt_outcome, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'web', ?, 'idle', 'succeeded', ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
    ).run(`s-${item.id}`, `settle:${item.id}`, item.id);
    return item.id;
  }

  it("holds a delegation (verify by provenance) in executing", () => {
    expect(reconcile.reconcileWorkItem(settled("delegated", "delegation"))?.item.status).toBe("executing");
  });

  it("closes a delegation that opted into trust, like a cron fire", () => {
    expect(reconcile.reconcileWorkItem(settled("fire and forget", "delegation", "trust"))?.item.status).toBe("done");
  });

  it("closes a cron fire (trust by provenance)", () => {
    expect(reconcile.reconcileWorkItem(settled("cron fire", "cron"))?.item.status).toBe("done");
  });
});
