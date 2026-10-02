import type { WorkItemStatus } from './store.js';

/** Declared edges: from → the set of legal targets (design §1.1's diagram).
 *  They govern every caller; the agent lane is the narrower set of pairs below
 *  (`isAgentLaneMove`), which the status route checks first. */
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
const AGENT_OPEN: readonly WorkItemStatus[] = ['backlog', 'executing', 'in_review'];

/** The agent lane: pick work up or put it down (backlog ↔ executing), hand it
 *  to review and take it back (executing ↔ in_review), and stop or resume any
 *  open Todo (open ↔ blocked), plus staying put. Every pair is also a declared
 *  edge. */
const AGENT_LANE: ReadonlySet<string> = new Set([
  'backlog>executing', 'executing>backlog', 'executing>in_review', 'in_review>executing',
  ...AGENT_OPEN.flatMap((open) => [`${open}>blocked`, `blocked>${open}`, `${open}>${open}`]),
  'blocked>blocked',
]);

export function isAgentLaneMove(from: WorkItemStatus, to: WorkItemStatus): boolean {
  return AGENT_LANE.has(`${from}>${to}`);
}
