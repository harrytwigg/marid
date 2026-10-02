import { initDb } from '../shared/db.js';
import { liveBackgroundSessionIds } from '../sessions/background-work.js';
import { appendWorkItemEvent, type WorkItemStatus } from './store.js';

/**
 * The claim on a Todo (ICI-729) — one row per Todo saying who is working it and
 * until when.
 *
 * Every automated pickup path claims before it works, so a second gateway or a
 * replayed trigger can never double-work the same Todo. The claim is decided by
 * ONE compare-and-swap whose rowcount is the whole answer: a read followed by a
 * write is two facts, and the gap between them is exactly where the second
 * worker gets in.
 *
 * Additive, never a column on `work_items`: the exact-shape verifier refuses any
 * drift in an existing table, so a new table is the only extension a deployed
 * database can survive. It is created lazily on first use, like the trigger
 * claim table in `workflow-event-feed.ts`, so no deployed database needs a
 * migration to gain it.
 *
 * A claim is a LEASE, not a lock, because the holder can die. It falls away when
 *
 *   - the holder releases it (every pickup path releases what it fails to use),
 *   - the session working it is no longer in flight — the same liveness the
 *     pickup paths asked about directly before this table existed, so a finished
 *     attempt frees its Todo at once rather than at the end of the lease, or
 *   - the lease runs out, audited as `claim_expired` — the backstop for a holder
 *     with no session to speak for it: a gateway that died mid-work, or a
 *     Workflow run that ended without handing its claim back.
 *
 * The lease is renewed from turn activity (`renewWorkItemClaimForSession`), so a
 * working agent never has to remember it holds one.
 */

const CLAIMS_TABLE = 'work_item_claims';

/** How long a claim survives without a heartbeat. */
export const TODO_CLAIM_LEASE_MS = 15 * 60_000;

let claimsTableReady = false;

function ensureClaimsTable(): ReturnType<typeof initDb> {
  const db = initDb();
  if (claimsTableReady) return db;
  db.exec(`CREATE TABLE IF NOT EXISTS ${CLAIMS_TABLE} (
    work_item_id      TEXT PRIMARY KEY REFERENCES work_items(id),
    owner             TEXT NOT NULL,
    session_id        TEXT,
    claimed_at        TEXT NOT NULL,
    claim_expires     TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL
  )`);
  claimsTableReady = true;
  return db;
}

export interface WorkItemClaim {
  workItemId: string;
  owner: string;
  /** The session doing the work, once one exists. Its liveness frees the claim
   *  ahead of the lease; a claim with no session rides the lease alone. */
  sessionId: string | null;
  claimedAt: string;
  claimExpires: string;
  lastHeartbeatAt: string;
}

export interface ClaimWorkItemInput {
  workItemId: string;
  owner: string;
  sessionId?: string | null;
  /** Refuse unless the Todo is in this status, decided inside the same statement
   *  as the claim so the status cannot move between the check and the take. */
  expectStatus?: WorkItemStatus;
}

/** `held` means somebody else is working it; `rejected` means the Todo itself
 *  refused (it is gone, or it is not in the status the caller required). */
export type ClaimWorkItemResult =
  | { state: 'acquired'; claim: WorkItemClaim }
  | { state: 'held'; claim: WorkItemClaim }
  | { state: 'rejected'; reason: string };

interface WorkItemClaimRow {
  work_item_id: string;
  owner: string;
  session_id: string | null;
  claimed_at: string;
  claim_expires: string;
  last_heartbeat_at: string;
}

function toClaim(row: WorkItemClaimRow): WorkItemClaim {
  return {
    workItemId: row.work_item_id,
    owner: row.owner,
    sessionId: row.session_id,
    claimedAt: row.claimed_at,
    claimExpires: row.claim_expires,
    lastHeartbeatAt: row.last_heartbeat_at,
  };
}

/** Who holds this Todo right now, lease and all. */
export function getWorkItemClaim(workItemId: string): WorkItemClaim | undefined {
  const row = ensureClaimsTable()
    .prepare(`SELECT * FROM ${CLAIMS_TABLE} WHERE work_item_id = ?`)
    .get(workItemId) as WorkItemClaimRow | undefined;
  return row ? toClaim(row) : undefined;
}

/**
 * The compare-and-swap, and the whole decision: `changes === 1` means this owner
 * has the Todo, and nothing read beforehand can make that true or false. The
 * insert selects from `work_items`, so an unknown Todo and a status the caller
 * refused both write nothing; the conflict clause is what a claim already on the
 * row has to survive.
 *
 * A holder whose turn ended with background sub-agents still working is stored
 * `idle`, so the session lookup alone would free its claim. `:liveBackground` is
 * the JSON array of such sessions (the gateway's in-memory overlay, which SQL
 * cannot see), and a claim held by one of them is as live as a running session.
 */
const CLAIM_CAS_SQL = `
INSERT INTO ${CLAIMS_TABLE} (work_item_id, owner, session_id, claimed_at, claim_expires, last_heartbeat_at)
SELECT :workItemId, :owner, :sessionId, :now, :expires, :now FROM work_items
 WHERE id = :workItemId AND (:expectStatus IS NULL OR status = :expectStatus)
    ON CONFLICT(work_item_id) DO UPDATE SET
      owner = excluded.owner,
      session_id = excluded.session_id,
      claimed_at = CASE WHEN ${CLAIMS_TABLE}.owner = excluded.owner
        THEN ${CLAIMS_TABLE}.claimed_at ELSE excluded.claimed_at END,
      claim_expires = excluded.claim_expires,
      last_heartbeat_at = excluded.last_heartbeat_at
    WHERE ${CLAIMS_TABLE}.owner = excluded.owner
       OR ${CLAIMS_TABLE}.claim_expires <= excluded.claimed_at
       OR (${CLAIMS_TABLE}.session_id IS NOT NULL AND ${CLAIMS_TABLE}.session_id NOT IN (
            SELECT id FROM sessions WHERE status IN ('running', 'waiting')
          ) AND ${CLAIMS_TABLE}.session_id NOT IN (SELECT value FROM json_each(:liveBackground)))`;

/**
 * Take the claim, or report who has it.
 *
 * The same owner re-claiming renews instead of losing: crash recovery re-enters
 * the path it was already on, and a worker must never deadlock against itself.
 */
export function claimWorkItem(input: ClaimWorkItemInput): ClaimWorkItemResult {
  const db = ensureClaimsTable();
  const now = new Date();
  const nowIso = now.toISOString();
  const written = db.prepare(CLAIM_CAS_SQL).run({
    workItemId: input.workItemId,
    owner: input.owner,
    sessionId: input.sessionId ?? null,
    now: nowIso,
    expires: new Date(now.getTime() + TODO_CLAIM_LEASE_MS).toISOString(),
    expectStatus: input.expectStatus ?? null,
    liveBackground: JSON.stringify(liveBackgroundSessionIds()),
  });
  if (written.changes === 1) {
    const taken = getWorkItemClaim(input.workItemId);
    if (!taken) throw new Error(`Todo ${input.workItemId} claim was written and then was not there to read`);
    return { state: 'acquired', claim: taken };
  }
  return refusal(db, input);
}

/** Why a claim did not happen: the Todo refused it, or somebody else holds it. */
function refusal(db: ReturnType<typeof initDb>, input: ClaimWorkItemInput): ClaimWorkItemResult {
  const status = db.prepare('SELECT status FROM work_items WHERE id = ?').pluck()
    .get(input.workItemId) as WorkItemStatus | undefined;
  if (!status) return { state: 'rejected', reason: `Todo ${input.workItemId} does not exist` };
  if (input.expectStatus && status !== input.expectStatus) {
    return { state: 'rejected', reason: `Todo ${input.workItemId} is ${status}, not ${input.expectStatus}` };
  }
  const held = getWorkItemClaim(input.workItemId);
  if (!held) return { state: 'rejected', reason: `Todo ${input.workItemId} refused the claim and holds none` };
  appendWorkItemEvent({
    workItemId: input.workItemId,
    kind: 'claim_rejected',
    actor: input.owner,
    detail: {
      heldBy: held.owner,
      ...(held.sessionId ? { sessionId: held.sessionId } : {}),
      expiresAt: held.claimExpires,
    },
    versionEffect: 'audit',
  });
  return { state: 'held', claim: held };
}

/** Give a claim back. Only its own owner can, so a late release from a worker
 *  whose lease already went to somebody else cannot unlock the new holder. */
export function releaseWorkItemClaim(workItemId: string, owner: string): boolean {
  return ensureClaimsTable()
    .prepare(`DELETE FROM ${CLAIMS_TABLE} WHERE work_item_id = ? AND owner = ?`)
    .run(workItemId, owner).changes > 0;
}

/** Give back whatever this session was holding — the shape a handoff takes,
 *  where the session that holds the Todo is the one passing it on. */
export function releaseWorkItemClaimForSession(sessionId: string): boolean {
  return ensureClaimsTable()
    .prepare(`DELETE FROM ${CLAIMS_TABLE} WHERE session_id = ?`)
    .run(sessionId).changes > 0;
}

/**
 * Renew the lease on whatever Todo this session is linked to. Driven by the turn
 * heartbeat, which is why it is keyed on the session being linked and live
 * rather than on owner identity: a Workflow run's claim is renewed by the phase
 * sessions doing its work, and the worst case is a live worker's lease living
 * slightly longer — strictly better than a lease that dies mid-work.
 */
export function renewWorkItemClaimForSession(sessionId: string, now: Date = new Date()): void {
  ensureClaimsTable().prepare(
    `UPDATE ${CLAIMS_TABLE} SET last_heartbeat_at = ?, claim_expires = ?
      WHERE work_item_id = (SELECT work_item_id FROM sessions WHERE id = ?)`,
  ).run(now.toISOString(), new Date(now.getTime() + TODO_CLAIM_LEASE_MS).toISOString(), sessionId);
}

/**
 * Release every lease that ran out and audit each one, so a Todo becoming
 * claimable again is a thing its own trail records rather than a silence.
 * Returns how many were released.
 */
export function expireWorkItemClaims(now: Date = new Date()): number {
  const db = ensureClaimsTable();
  const nowIso = now.toISOString();
  return db.transaction((): number => {
    const expired = db.prepare(`SELECT * FROM ${CLAIMS_TABLE} WHERE claim_expires <= ?`)
      .all(nowIso) as WorkItemClaimRow[];
    if (expired.length === 0) return 0;
    db.prepare(`DELETE FROM ${CLAIMS_TABLE} WHERE claim_expires <= ?`).run(nowIso);
    for (const row of expired) {
      appendWorkItemEvent({
        workItemId: row.work_item_id,
        kind: 'claim_expired',
        actor: row.owner,
        detail: { expiredAt: row.claim_expires, lastHeartbeatAt: row.last_heartbeat_at },
        versionEffect: 'audit',
      });
    }
    return expired.length;
  }).immediate();
}
