import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-claims-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Claims = typeof import("../claims.js");
type BackgroundWork = typeof import("../../sessions/background-work.js");
let store: Store;
let claims: Claims;
let backgroundWork: BackgroundWork;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  claims = await import("../claims.js");
  backgroundWork = await import("../../sessions/background-work.js");
  db = (await import("../../shared/db.js")).initDb();
});

function claimKinds(workItemId: string): string[] {
  return store.listWorkItemEvents(workItemId)
    .filter((event) => event.kind === "claim_rejected" || event.kind === "claim_expired")
    .map((event) => event.kind);
}

/** Move a claim's lease, which is the only way to reach a lease boundary
 *  without holding the suite for fifteen minutes. */
function moveLease(workItemId: string, expiresInMs: number): void {
  db.prepare("UPDATE work_item_claims SET claim_expires = ? WHERE work_item_id = ?")
    .run(new Date(Date.now() + expiresInMs).toISOString(), workItemId);
}

const LEASE_RAN_OUT = -60_000;
/** Live, but far enough short of a full TTL that a renewal is measurable. */
const LEASE_ALMOST_UP = 60_000;

describe("the claims table", () => {
  // Declared first on purpose: it is only true before anything claims. A
  // database that predates this table gains it on first use, which is why the
  // boot-time schema verifier neither knows nor asks about it.
  it("is absent after a boot that migrated the schema, and appears on first use", () => {
    const exists = () => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("work_item_claims");
    expect(exists()).toBeUndefined();

    claims.getWorkItemClaim(store.createWorkItem({ title: "first ever claim read" }).id);

    expect(exists()).toBeDefined();
  });
});

describe("claimWorkItem", () => {
  it("gives the Todo to the first owner and reports the holder to the second", () => {
    const item = store.createWorkItem({ title: "contended" });

    const first = claims.claimWorkItem({ workItemId: item.id, owner: "owner-a" });
    const second = claims.claimWorkItem({ workItemId: item.id, owner: "owner-b" });

    expect(first.state).toBe("acquired");
    expect(second).toMatchObject({ state: "held", claim: { owner: "owner-a" } });
    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("owner-a");
  });

  it("audits a lost claim without advancing the Todo's version", () => {
    const item = store.createWorkItem({ title: "audited loss" });
    claims.claimWorkItem({ workItemId: item.id, owner: "owner-a" });
    const before = store.getWorkItem(item.id)!.version;

    claims.claimWorkItem({ workItemId: item.id, owner: "owner-b" });

    const rejected = store.listWorkItemEvents(item.id).filter((event) => event.kind === "claim_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ actor: "owner-b", detail: { heldBy: "owner-a" } });
    expect(store.getWorkItem(item.id)!.version).toBe(before);
  });

  it("refuses a status the caller did not ask for, and writes no claim row", () => {
    const item = store.createWorkItem({ title: "wrong status", status: "backlog" });

    const result = claims.claimWorkItem({ workItemId: item.id, owner: "owner-a", expectStatus: "executing" });

    expect(result).toMatchObject({ state: "rejected" });
    expect(result.state === "rejected" && result.reason).toContain("backlog");
    expect(claims.getWorkItemClaim(item.id)).toBeUndefined();
    expect(claimKinds(item.id)).toEqual([]);
  });

  it("refuses a Todo that does not exist", () => {
    const result = claims.claimWorkItem({ workItemId: "ICI-999999", owner: "owner-a" });

    expect(result).toMatchObject({ state: "rejected" });
    expect(result.state === "rejected" && result.reason).toContain("does not exist");
  });

  // The lease is still LIVE, so nothing but the same-owner arm of the CAS can
  // grant this: a claim that renewed because its lease had run out would prove
  // the expiry arm and say nothing about re-entrancy.
  it("renews rather than refuses when the same owner re-claims, and extends the lease", () => {
    const item = store.createWorkItem({ title: "re-entrant" });
    const first = claims.claimWorkItem({ workItemId: item.id, owner: "owner-a" });
    moveLease(item.id, LEASE_ALMOST_UP);

    const again = claims.claimWorkItem({ workItemId: item.id, owner: "owner-a", sessionId: "session-a" });

    expect(again.state).toBe("acquired");
    const renewed = claims.getWorkItemClaim(item.id)!;
    expect(renewed.sessionId).toBe("session-a");
    // The lease moved a full TTL out; the moment this owner took the Todo did not.
    expect(Date.parse(renewed.claimExpires) - Date.now()).toBeGreaterThan(claims.TODO_CLAIM_LEASE_MS - 60_000);
    expect(renewed.claimedAt).toBe(first.state === "acquired" ? first.claim.claimedAt : "");
  });

  it("lets a new owner take a claim whose lease has run out", () => {
    const item = store.createWorkItem({ title: "abandoned" });
    claims.claimWorkItem({ workItemId: item.id, owner: "owner-a" });
    moveLease(item.id, LEASE_RAN_OUT);

    const taken = claims.claimWorkItem({ workItemId: item.id, owner: "owner-b" });

    expect(taken.state).toBe("acquired");
    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("owner-b");
  });
});

describe("claimWorkItem against a holder whose turn has ended", () => {
  function seedIdleSession(sessionId: string, workItemId: string): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'web', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `web:${sessionId}`, workItemId, now, now);
  }

  it("lets a new owner take the claim from an idle session with nothing running behind it", () => {
    const item = store.createWorkItem({ title: "producer finished", status: "executing" });
    seedIdleSession("idle-holder", item.id);
    claims.claimWorkItem({ workItemId: item.id, owner: "owner-a", sessionId: "idle-holder" });

    expect(claims.claimWorkItem({ workItemId: item.id, owner: "owner-b" }).state).toBe("acquired");
  });

  it("refuses a new owner while the idle holder still has background sub-agents working", () => {
    const item = store.createWorkItem({ title: "producer mapping in the background", status: "executing" });
    seedIdleSession("background-holder", item.id);
    claims.claimWorkItem({ workItemId: item.id, owner: "owner-a", sessionId: "background-holder" });

    backgroundWork.runtimeActivity.set("background-holder", { activeStreams: 0, activeAgents: 0, backgroundAgents: 1, lastActivityAt: Date.now() });
    try {
      expect(claims.claimWorkItem({ workItemId: item.id, owner: "owner-b" }))
        .toMatchObject({ state: "held", claim: { owner: "owner-a", sessionId: "background-holder" } });

      // The overlay is the whole difference: once the sub-agents report finished the
      // same holder is idle again and the claim is free to take.
      backgroundWork.runtimeActivity.delete("background-holder");
      expect(claims.claimWorkItem({ workItemId: item.id, owner: "owner-b" }).state).toBe("acquired");
    } finally {
      backgroundWork.runtimeActivity.delete("background-holder");
    }
  });

  it("still lets the lease run out on a holder with background work, so a dead engine cannot pin the Todo", () => {
    const item = store.createWorkItem({ title: "background work that never reports", status: "executing" });
    seedIdleSession("stuck-holder", item.id);
    claims.claimWorkItem({ workItemId: item.id, owner: "owner-a", sessionId: "stuck-holder" });
    moveLease(item.id, LEASE_RAN_OUT);

    backgroundWork.runtimeActivity.set("stuck-holder", { activeStreams: 0, backgroundAgents: 1, lastActivityAt: Date.now() });
    try {
      expect(claims.claimWorkItem({ workItemId: item.id, owner: "owner-b" }).state).toBe("acquired");
    } finally {
      backgroundWork.runtimeActivity.delete("stuck-holder");
    }
  });
});

describe("expireWorkItemClaims", () => {
  it("releases an expired lease and says so in the Todo's trail", () => {
    const item = store.createWorkItem({ title: "vanished worker" });
    claims.claimWorkItem({ workItemId: item.id, owner: "owner-a" });
    moveLease(item.id, LEASE_RAN_OUT);

    expect(claims.expireWorkItemClaims()).toBe(1);

    expect(claims.getWorkItemClaim(item.id)).toBeUndefined();
    const expired = store.listWorkItemEvents(item.id).filter((event) => event.kind === "claim_expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ actor: "owner-a" });
  });

  it("leaves a live lease alone", () => {
    const item = store.createWorkItem({ title: "still working" });
    claims.claimWorkItem({ workItemId: item.id, owner: "owner-a" });

    expect(claims.expireWorkItemClaims()).toBe(0);
    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("owner-a");
  });
});

describe("releaseWorkItemClaim", () => {
  it("frees the Todo for its owner and refuses anybody else's release", () => {
    const item = store.createWorkItem({ title: "handed back" });
    claims.claimWorkItem({ workItemId: item.id, owner: "owner-a" });

    expect(claims.releaseWorkItemClaim(item.id, "owner-b")).toBe(false);
    expect(claims.releaseWorkItemClaim(item.id, "owner-a")).toBe(true);
    expect(claims.getWorkItemClaim(item.id)).toBeUndefined();
  });
});
