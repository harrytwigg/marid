import type { WorkItemStatus } from './store.js';

/** Declared edges: from → the set of legal targets (design §1.1's diagram).
 *  Governs the human and derived lanes; the agent lane (`opts.agent`) and the
 *  workflow re-arm lane (`opts.requeue`) are bounded by their caller's target
 *  allowlist instead. */
export const EDGES: Readonly<Record<WorkItemStatus, ReadonlySet<WorkItemStatus>>> = {
  // `done` from backlog covers trivially-completed work — rare, but refusing it
  // would strand a truthful terminal.
  backlog: new Set(['executing', 'in_review', 'blocked', 'done', 'cancelled']),
  // `backlog` here is "not now": work picked up too early goes back down.
  executing: new Set(['backlog', 'in_review', 'blocked', 'done', 'cancelled']),
  in_review: new Set(['executing', 'done', 'blocked', 'cancelled']),
  blocked: new Set(['backlog', 'executing', 'in_review', 'done', 'cancelled']),
  // Sticky terminals: leaving them is HUMAN-ONLY (enforced in transitions.ts, not by
  // edge absence).
  done: new Set(['backlog']),
  cancelled: new Set(['backlog']),
};

/** The statuses an agent session works in. Closing (`done`, `cancelled`) and
 *  reopening closed work are the operator's. */
const AGENT_OPEN: ReadonlySet<WorkItemStatus> = new Set(['backlog', 'executing', 'in_review']);

/** The agent lane: pick work up or put it down (backlog ↔ executing), hand it
 *  to review and take it back (executing ↔ in_review), and stop or resume any
 *  open Todo (open ↔ blocked). Every pair is also a declared edge. */
export function isAgentLaneMove(from: WorkItemStatus, to: WorkItemStatus): boolean {
  if (from === to) return AGENT_OPEN.has(from) || from === 'blocked';
  if (to === 'blocked') return AGENT_OPEN.has(from);
  if (from === 'blocked') return AGENT_OPEN.has(to);
  return (from === 'backlog' && to === 'executing') || (from === 'executing' && to === 'backlog')
    || (from === 'executing' && to === 'in_review') || (from === 'in_review' && to === 'executing');
}
