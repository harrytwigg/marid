import { randomUUID } from 'node:crypto';
import { initDb } from '../shared/db.js';
import { isRateLimitMessage } from '../shared/rateLimit.js';
import type { SessionAttemptOutcome } from '../shared/types.js';
import { TODO_RUN_OUTCOMES, type TodoRunOutcome } from './runs-schema.js';
import { LEGACY_WORKFLOW_PHASE_SQL } from '../sessions/legacy-workflow-phase.js';

/**
 * The Todo run ledger — one row per work attempt (ICI-728).
 *
 * A Todo says what has to happen; a RUN says what one attempt at it actually
 * did. Which files it touched, which checks it ran, what it would tell the next
 * attempt, and what risk it left behind are facts about the attempt, so they
 * live here and not on the Todo, where a retry would overwrite them.
 *
 * Two rules the rest of the platform leans on:
 *
 *   - A run is OPEN (no end, no outcome) or SETTLED (both). The DDL enforces
 *     the pair; `closeWorkItemRun` enforces that settling happens once.
 *   - A close takes exactly ONE run id. There is deliberately no bulk close:
 *     a handoff describes one attempt, and one summary spread over several
 *     attempts is a lie about all but one of them.
 */

export type { TodoRunOutcome } from './runs-schema.js';

/** What an attempt hands the next one. Everything is optional — the platform
 *  stores and surfaces what the attempt reported, it never invents it. */
export interface TodoRunHandoff {
  changedFiles?: string[];
  verification?: string;
  retryNotes?: string;
  residualRisk?: string;
}

export interface TodoRun {
  id: string; // wir_<12hex>
  workItemId: string;
  sessionId: string;
  startedAt: string;
  /** NULL while the attempt is still running. */
  endedAt: string | null;
  outcome: TodoRunOutcome | null;
  summary: string | null;
  handoff: TodoRunHandoff;
  error: string | null;
}

export interface OpenWorkItemRunInput {
  workItemId: string;
  sessionId: string;
  startedAt?: string;
}

export interface CloseWorkItemRunInput {
  outcome: TodoRunOutcome;
  summary?: string | null;
  /** Raw as the attempt reported it; normalized before it is stored. */
  handoff?: unknown;
  error?: string | null;
  endedAt?: string;
}

interface WorkItemRunRow {
  id: string;
  work_item_id: string;
  session_id: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  summary: string | null;
  metadata: string | null;
  error: string | null;
}

/** The handoff arrives from a workflow node's authored output, where the Todo's
 *  own contract names the keys in snake_case, and from platform code, which
 *  speaks the camelCase every other field here uses. Both spellings are read;
 *  one is stored. Anything else is dropped rather than persisted unread. */
const HANDOFF_NOTES = [
  { key: 'verification', wire: 'verification' },
  { key: 'retryNotes', wire: 'retry_notes' },
  { key: 'residualRisk', wire: 'residual_risk' },
] as const;

export function normalizeTodoRunHandoff(value: unknown): TodoRunHandoff {
  const source = asRecord(value);
  if (!source) return {};
  const handoff: TodoRunHandoff = {};
  const files = stringList(source.changedFiles ?? source.changed_files);
  if (files.length > 0) handoff.changedFiles = files;
  for (const note of HANDOFF_NOTES) {
    const reported = source[note.key] ?? source[note.wire];
    if (typeof reported === 'string' && reported.length > 0) handoff[note.key] = reported;
  }
  return handoff;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function toRun(row: WorkItemRunRow): TodoRun {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome as TodoRunOutcome | null,
    summary: row.summary,
    handoff: row.metadata === null ? {} : normalizeTodoRunHandoff(safeParse(row.metadata)),
    error: row.error,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/**
 * Start the ledger row for an attempt. Idempotent per session: a dispatch path
 * that runs twice for the same attempt (crash recovery re-entering the same
 * session) gets the run it already opened, never a second row.
 */
export function openWorkItemRun(input: OpenWorkItemRunInput): TodoRun {
  const db = initDb();
  const startedAt = input.startedAt ?? new Date().toISOString();
  return db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM work_item_runs WHERE work_item_id = ? AND session_id = ? AND ended_at IS NULL')
      .get(input.workItemId, input.sessionId) as WorkItemRunRow | undefined;
    if (existing) return toRun(existing);
    if (!db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(input.workItemId)) {
      throw new Error(`Cannot open a run: Todo ${input.workItemId} does not exist.`);
    }
    const row: WorkItemRunRow = {
      id: `wir_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      work_item_id: input.workItemId,
      session_id: input.sessionId,
      started_at: startedAt,
      ended_at: null,
      outcome: null,
      summary: null,
      metadata: null,
      error: null,
    };
    db.prepare(
      `INSERT INTO work_item_runs (id, work_item_id, session_id, started_at, ended_at, outcome, summary, metadata, error)
       VALUES (@id, @work_item_id, @session_id, @started_at, @ended_at, @outcome, @summary, @metadata, @error)`,
    ).run(row);
    return toRun(row);
  })();
}

/**
 * Settle exactly one run. Refuses an unknown id, an outcome outside the frozen
 * six, and a run that is already settled — a second close would overwrite a
 * handoff somebody is meant to read.
 */
export function closeWorkItemRun(runId: string, input: CloseWorkItemRunInput): TodoRun {
  if (!(TODO_RUN_OUTCOMES as readonly string[]).includes(input.outcome)) {
    throw new Error(`Unknown run outcome \`${String(input.outcome)}\` — expected one of ${TODO_RUN_OUTCOMES.join(', ')}.`);
  }
  const db = initDb();
  const endedAt = input.endedAt ?? new Date().toISOString();
  const handoff = normalizeTodoRunHandoff(input.handoff);
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM work_item_runs WHERE id = ?').get(runId) as WorkItemRunRow | undefined;
    if (!row) throw new Error(`Run ${runId} was not found.`);
    if (row.ended_at !== null) throw new Error(`Run ${runId} is already closed (${row.outcome}).`);
    const metadata = Object.keys(handoff).length > 0 ? JSON.stringify(handoff) : null;
    db.prepare(
      'UPDATE work_item_runs SET ended_at = ?, outcome = ?, summary = ?, metadata = ?, error = ? WHERE id = ?',
    ).run(endedAt, input.outcome, input.summary ?? null, metadata, input.error ?? null, runId);
    return toRun({ ...row, ended_at: endedAt, outcome: input.outcome, summary: input.summary ?? null, metadata,
      error: input.error ?? null });
  })();
}

/** A Todo's attempts, oldest first — the order a reviewer reads them in. */
export function listWorkItemRuns(workItemId: string): TodoRun[] {
  const rows = initDb()
    .prepare('SELECT * FROM work_item_runs WHERE work_item_id = ? ORDER BY started_at, rowid')
    .all(workItemId) as WorkItemRunRow[];
  return rows.map(toRun);
}

/**
 * A Todo's runs, oldest first, without those of a legacy Workflow phase
 * session: a phase was linked only so its spend rolled up here, so its run says
 * nothing about the Todo's own attempts. Recovery, the respawn guards and the
 * availability sweep judge the Todo by these.
 */
export function listWorkItemAttemptRuns(workItemId: string): TodoRun[] {
  const rows = initDb()
    .prepare(
      `SELECT * FROM work_item_runs
        WHERE work_item_id = ?
          AND session_id NOT IN (SELECT id FROM sessions WHERE ${LEGACY_WORKFLOW_PHASE_SQL})
        ORDER BY started_at, rowid`,
    )
    .all(workItemId) as WorkItemRunRow[];
  return rows.map(toRun);
}

/** The still-running attempt on this session, if the ledger has one. */
export function findOpenWorkItemRunBySession(sessionId: string): TodoRun | undefined {
  const row = initDb()
    .prepare('SELECT * FROM work_item_runs WHERE session_id = ? AND ended_at IS NULL ORDER BY started_at DESC, rowid DESC')
    .get(sessionId) as WorkItemRunRow | undefined;
  return row ? toRun(row) : undefined;
}

/**
 * Startup sweep: an attempt whose session no longer exists never reported an
 * outcome and never will. `crashed` is the honest reading — the work stopped
 * somewhere nobody recorded. Returns how many runs were settled.
 */
export function closeOrphanedWorkItemRuns(endedAt: string = new Date().toISOString()): number {
  return initDb()
    .prepare(
      `UPDATE work_item_runs SET ended_at = ?, outcome = 'crashed',
         error = 'The session running this attempt is gone; the attempt never reported an outcome.'
       WHERE ended_at IS NULL AND session_id NOT IN (SELECT id FROM sessions)`,
    )
    .run(endedAt).changes;
}

/** How a session's terminal receipt reads in this ledger's vocabulary.
 *  `crashed` and `timed_out` are absent because no session receipt claims them:
 *  a vanished session is settled by the orphan sweep instead. */
export const RUN_OUTCOME_BY_RECEIPT: Record<SessionAttemptOutcome, TodoRunOutcome> = {
  succeeded: 'completed',
  failed: 'blocked',
  interrupted: 'abandoned',
};

/**
 * How a receipt reads once its error text is taken into account. A session the
 * provider turned away did not fail at the work — it never got to do any — so a
 * quota window settles as `rate_limited` rather than as `blocked`, whatever the
 * receipt calls it. Only a receipt that did NOT succeed is reinterpreted: a
 * finished attempt is finished no matter what its logs mention.
 */
export function runOutcomeForReceipt(receipt: SessionAttemptOutcome, error: string | null): TodoRunOutcome {
  if (receipt !== 'succeeded' && isRateLimitMessage(error)) return 'rate_limited';
  return RUN_OUTCOME_BY_RECEIPT[receipt];
}

/**
 * Sweep: close every open run whose session has already reported a terminal
 * receipt.
 *
 * The per-Todo reconciler normally does this, but it is only reached for
 * NON-sticky statuses. Cancel a Todo while its delegated child is still running
 * and nothing ever looks at that child's receipt again — the orphan sweep above
 * does not save it either, because the session is present, not gone. The row
 * would read as still running forever, which is worse than no row at all.
 *
 * Driven off the open rows rather than the Todo list: it is O(open runs) and
 * covers `done` and `escalated` on the same terms, instead of re-deriving every
 * closed Todo in history on each tick.
 *
 * Returns how many runs were settled.
 */
export function closeRunsForSettledSessions(endedAt: string = new Date().toISOString()): number {
  const settled = initDb()
    .prepare(
      `SELECT runs.id AS id, sessions.attempt_outcome AS outcome, sessions.last_error AS error
         FROM work_item_runs AS runs JOIN sessions ON sessions.id = runs.session_id
        WHERE runs.ended_at IS NULL AND sessions.attempt_outcome IS NOT NULL`,
    )
    .all() as { id: string; outcome: SessionAttemptOutcome; error: string | null }[];
  for (const run of settled) {
    closeWorkItemRun(run.id, { outcome: runOutcomeForReceipt(run.outcome, run.error), endedAt });
  }
  return settled.length;
}
