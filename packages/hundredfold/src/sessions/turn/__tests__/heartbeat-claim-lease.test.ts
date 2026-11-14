import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from HUNDREDFOLD_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-heartbeat-claim-"));
process.env.HUNDREDFOLD_HOME = tmp;

type Registry = typeof import("../../registry.js");
type Store = typeof import("../../../work-items/store.js");
type Claims = typeof import("../../../work-items/claims.js");
type Heartbeat = typeof import("../heartbeat.js");

let registry: Registry;
let store: Store;
let claims: Claims;
let heartbeat: Heartbeat;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  registry = await import("../../registry.js");
  store = await import("../../../work-items/store.js");
  claims = await import("../../../work-items/claims.js");
  heartbeat = await import("../heartbeat.js");
  db = (await import("../../../shared/db.js")).initDb();
});

function backdateLease(workItemId: string, to: string): void {
  db.prepare("UPDATE work_item_claims SET claim_expires = ?, last_heartbeat_at = ? WHERE work_item_id = ?")
    .run(to, to, workItemId);
}

describe("the turn heartbeat and the Todo claim", () => {
  it("advances the lease of the Todo its session is working, with no call from the agent", () => {
    const item = store.createWorkItem({ title: "worked by a live turn" });
    const session = registry.createSession({
      engine: "codex", source: "web", sourceRef: "heartbeat-lease", connector: "web", prompt: "work",
    });
    store.linkSession(item.id, session.id);
    claims.claimWorkItem({ workItemId: item.id, owner: "owner-a", sessionId: session.id });
    const stale = "2026-01-01T00:00:00.000Z";
    backdateLease(item.id, stale);

    const running = registry.beginSessionAttempt(session.id)!;
    const beat = heartbeat.armTurnHeartbeat(session.id, running.attemptToken!);
    beat.beat();
    beat.stop();

    const renewed = claims.getWorkItemClaim(item.id)!;
    expect(renewed.owner).toBe("owner-a");
    expect(Date.parse(renewed.lastHeartbeatAt)).toBeGreaterThan(Date.parse(stale));
    expect(Date.parse(renewed.claimExpires) - Date.now())
      .toBeGreaterThan(claims.TODO_CLAIM_LEASE_MS - 60_000);
  });

  it("leaves other Todos' claims alone", () => {
    const worked = store.createWorkItem({ title: "the one being worked" });
    const bystander = store.createWorkItem({ title: "somebody else's Todo" });
    const session = registry.createSession({
      engine: "codex", source: "web", sourceRef: "heartbeat-bystander", connector: "web", prompt: "work",
    });
    store.linkSession(worked.id, session.id);
    claims.claimWorkItem({ workItemId: worked.id, owner: "owner-a", sessionId: session.id });
    claims.claimWorkItem({ workItemId: bystander.id, owner: "owner-b" });
    const stale = "2026-01-01T00:00:00.000Z";
    backdateLease(bystander.id, stale);

    const running = registry.beginSessionAttempt(session.id)!;
    const beat = heartbeat.armTurnHeartbeat(session.id, running.attemptToken!);
    beat.beat();
    beat.stop();

    expect(claims.getWorkItemClaim(bystander.id)?.claimExpires).toBe(stale);
  });
});
