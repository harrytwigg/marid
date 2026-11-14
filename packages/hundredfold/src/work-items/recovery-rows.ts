import { initDb } from "../shared/db.js";
import { MAX_RECOVERY_ATTEMPTS, type RecoveryClass, type AttentionLane, type UpsertRecoveryInput, type WorkItemRecovery } from "./recovery.js";

interface RecoveryRow {
  work_item_id: string;
  incident_id: string;
  class: RecoveryClass;
  lane: AttentionLane;
  attempts: number;
  last_attempt_at: string | null;
  last_run_id: string | null;
  reason: string;
  updated_at: string;
}

function toRecovery(row: RecoveryRow): WorkItemRecovery {
  return {
    workItemId: row.work_item_id,
    incidentId: row.incident_id,
    class: row.class,
    lane: row.lane,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    lastRunId: row.last_run_id,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
}

export function getWorkItemRecovery(workItemId: string): WorkItemRecovery | undefined {
  const row = initDb()
    .prepare("SELECT * FROM work_item_recovery WHERE work_item_id = ?")
    .get(workItemId) as RecoveryRow | undefined;
  return row ? toRecovery(row) : undefined;
}

/** Batch form for list payloads: ONE query for the whole page. */
export function recoveryByItem(workItemIds: readonly string[]): Map<string, WorkItemRecovery> {
  const ids = [...new Set(workItemIds)];
  const map = new Map<string, WorkItemRecovery>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = initDb()
    .prepare(`SELECT * FROM work_item_recovery WHERE work_item_id IN (${placeholders})`)
    .all(...ids) as RecoveryRow[];
  for (const row of rows) map.set(row.work_item_id, toRecovery(row));
  return map;
}

/** The operator's own decision ends an incident: a row classified from an
 *  attempt he has since moved the Todo past describes nothing current. */
export function clearWorkItemRecovery(workItemId: string): void {
  initDb().prepare("DELETE FROM work_item_recovery WHERE work_item_id = ?").run(workItemId);
}

function nextAttempts(existing: WorkItemRecovery | undefined, incidentId: string, attempted: boolean | undefined, now: string) {
  const sameIncident = existing !== undefined && existing.incidentId === incidentId;
  return {
    attempts: sameIncident
      ? Math.min(MAX_RECOVERY_ATTEMPTS, existing.attempts + (attempted ? 1 : 0))
      : attempted ? 1 : 0,
    lastAttemptAt: attempted ? now : (sameIncident ? existing.lastAttemptAt : null),
  };
}

export function upsertWorkItemRecovery(input: UpsertRecoveryInput): WorkItemRecovery {
  const now = (input.now ?? new Date()).toISOString();
  const existing = getWorkItemRecovery(input.workItemId);
  const { attempts, lastAttemptAt } = nextAttempts(existing, input.incidentId, input.attempted, now);
  initDb().prepare(
    `INSERT INTO work_item_recovery
       (work_item_id, incident_id, class, lane, attempts, last_attempt_at, last_run_id, reason, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET
       incident_id = excluded.incident_id,
       class = excluded.class,
       lane = excluded.lane,
       attempts = excluded.attempts,
       last_attempt_at = excluded.last_attempt_at,
       last_run_id = excluded.last_run_id,
       reason = excluded.reason,
       updated_at = excluded.updated_at`,
  ).run(
    input.workItemId, input.incidentId, input.class, input.lane, attempts, lastAttemptAt,
    input.lastRunId ?? existing?.lastRunId ?? null, input.reason, now,
  );
  return getWorkItemRecovery(input.workItemId)!;
}
