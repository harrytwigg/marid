import type { Session } from "../shared/types.js";

/**
 * Session rows the removed Workflow runtime left behind. Every session it created
 * was a phase attempt, stored with source `workflow` and `workflow_kind = 'phase'`,
 * and nothing else writes either value, so the tests below name the same rows: one
 * for a query against the sessions table, one for a raw row, one for a loaded
 * `Session` (which does not carry the column).
 */
export const LEGACY_WORKFLOW_PHASE_SQL = "workflow_kind = 'phase'";

/** The same test on a raw sessions row, where the column is at hand. */
export function isLegacyWorkflowPhaseRow(row: Record<string, unknown>): boolean {
  return row.workflow_kind === "phase";
}

export function isLegacyWorkflowPhaseSession(session: Pick<Session, "source">): boolean {
  return session.source === "workflow";
}
