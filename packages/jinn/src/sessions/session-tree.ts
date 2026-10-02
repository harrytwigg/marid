import type { Session, WorkItemLinkRole } from '../shared/types.js';
import { listComments } from '../work-items/comments.js';
import { listWorkItemEvents } from '../work-items/event-log.js';
import { toWorkItemLinkRole } from '../work-items/link-role.js';
import { getWorkItem } from '../work-items/store.js';
import { listSessions } from './registry.js';

/**
 * The tree of sessions a Todo caused: the sessions linked to it, and beneath
 * each, the sessions delegated out of it.
 *
 * Both halves of this walk already existed and nothing joined them —
 * `listSessionsByWorkItem` gives the roots, `parent_session_id` gives the
 * edges, and the browser could reach each half one HTTP call at a time. Walking
 * it from the browser is one round trip per node with no bound on depth, so the
 * join lives here and the route answers in one response.
 *
 * Nothing in this file queries. The caller hands over the sessions it has
 * already read (the route was already reading the whole table to build the
 * delegated-activity index), which is also what makes the walk testable against
 * a hand-built array instead of a database.
 *
 * There are deliberately NO tombstone nodes in the tree. A session linked to a
 * work item cannot be hard-deleted — `deleteSession` and `deleteSessions` both
 * carry `WHERE ... work_item_id IS NULL` (registry.ts), and the route refuses
 * in bulk too — so every node reachable here is a row that still exists. The
 * only deletable session is an untracked spawn, and when one of those goes its
 * `parent_session_id` edge goes with it: nothing links its children back to
 * this Todo any more, so grafting them onto a placeholder root would attach
 * unrelated work rather than preserve provenance. A named-but-absent id is
 * still reported, in `directory`, where the Todo itself supplies the id.
 */

/** Deeper than a dispatcher → delegate → sub-delegate → reviewer chain with
 *  headroom. A tree past this is a runaway, and the truncation marker is how
 *  the operator gets told about it rather than shown a short tree. */
export const SESSION_TREE_MAX_DEPTH = 6;

/** Well above the 50-node interactivity target the spec measures, so the bound
 *  never fires in the case the success criteria care about. */
export const SESSION_TREE_MAX_NODES = 200;

export interface SessionTreeNode {
  id: string;
  employee: string | null;
  status: string | null;
  title: string | null;
  /** Why this session is attached to the Todo it tracks. A NULL column reads as
   *  `execute` — the meaning it already carries in `link-role.ts`. */
  role: WorkItemLinkRole;
  workItemId: string | null;
  /** True when this session is linked directly to the Todo being viewed. */
  isRootLink: boolean;
  archived: boolean;
  truncated: { reason: 'depth' | 'count' } | null;
  children: SessionTreeNode[];
}

export interface SessionDirectoryEntry {
  id: string;
  employee: string | null;
  status: string | null;
  title: string | null;
  archived: boolean;
  /** The Todo names this id but no session row answers to it. Only reachable
   *  for a directly named id (a `created_by`, a comment author): see the note
   *  on tombstones above. */
  missing: boolean;
}

export interface SessionTreeResponse {
  roots: SessionTreeNode[];
  /** Identity for every session id the Todo mentions, tree or not: a session
   *  that MINTED this Todo need not be linked to it, and the Todo page still
   *  has to render its name instead of a raw id. */
  directory: Record<string, SessionDirectoryEntry>;
  truncated: { depth: boolean; count: boolean };
  totals: { nodes: number; live: number };
}

export interface SessionTreeInput {
  todoId: string;
  /** Every session in play — the caller's already-loaded array, not a query. */
  sessions: readonly Session[];
  /** Extra ids the Todo names elsewhere: its `created_by`, its comment authors,
   *  its audit actors. Bare ids, `session:` prefix already stripped. */
  referencedSessionIds?: readonly string[];
}

const LIVE_STATUSES = new Set(['running', 'waiting']);

function isArchived(session: Session): boolean {
  return Boolean(session.archivedAt);
}

function directoryEntry(session: Session): SessionDirectoryEntry {
  return {
    id: session.id,
    employee: session.employee ?? null,
    status: session.status ?? null,
    title: session.title ?? null,
    archived: isArchived(session),
    missing: false,
  };
}

function missingDirectoryEntry(id: string): SessionDirectoryEntry {
  return { id, employee: null, status: null, title: null, archived: false, missing: true };
}

function nodeFor(session: Session, todoId: string): SessionTreeNode {
  return {
    id: session.id,
    employee: session.employee ?? null,
    status: session.status ?? null,
    title: session.title ?? null,
    role: toWorkItemLinkRole(session.workItemRole),
    workItemId: session.workItemId ?? null,
    isRootLink: session.workItemId === todoId,
    archived: isArchived(session),
    truncated: null,
    children: [],
  };
}

/** Children indexed by parent, ordered newest activity first so siblings read
 *  in the same order the session lists elsewhere use. */
function childIndex(sessions: readonly Session[]): Map<string, Session[]> {
  const index = new Map<string, Session[]>();
  for (const session of sessions) {
    const parent = session.parentSessionId;
    if (!parent) continue;
    const bucket = index.get(parent);
    if (bucket) bucket.push(session);
    else index.set(parent, [session]);
  }
  for (const bucket of index.values()) {
    bucket.sort((a, b) => String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? '')));
  }
  return index;
}

/**
 * Breadth-first so that when a bound bites, what survives is the shallow part
 * of the tree — the part the operator can act on — rather than one deep branch
 * with its siblings missing.
 *
 * `visited` carries the same containment rule `buildDelegatedActivityIndex`
 * already applies to the ancestor walk: `parent_session_id` is a plain nullable
 * column with nothing stopping a cycle, and one tested answer to that is
 * better than two that can drift apart.
 */
interface WalkState {
  visited: Set<string>;
  truncated: { depth: boolean; count: boolean };
  nodes: number;
}

/** One level down from `frontier`, returning the level it produced. Bounded by
 *  the node budget, which is reported on the parent whose children it withheld
 *  rather than applied as a silent slice. */
function expand(
  frontier: readonly SessionTreeNode[],
  children: ReadonlyMap<string, Session[]>,
  todoId: string,
  state: WalkState,
): SessionTreeNode[] {
  const next: SessionTreeNode[] = [];
  for (const node of frontier) {
    for (const child of children.get(node.id) ?? []) {
      // A cycle, or a session reachable by two paths: counting it twice would
      // let a node become its own descendant and the walk never finish.
      if (state.visited.has(child.id)) continue;
      if (state.nodes >= SESSION_TREE_MAX_NODES) {
        state.truncated.count = true;
        node.truncated = { reason: 'count' };
        break;
      }
      state.visited.add(child.id);
      state.nodes += 1;
      const childNode = nodeFor(child, todoId);
      node.children.push(childNode);
      next.push(childNode);
    }
  }
  return next;
}

/** The depth ceiling, marked on every node that still had children below it. */
function markDepthBound(frontier: readonly SessionTreeNode[], children: ReadonlyMap<string, Session[]>, state: WalkState): void {
  state.truncated.depth = true;
  for (const node of frontier) {
    if (children.has(node.id)) node.truncated = { reason: 'depth' };
  }
}

export function buildSessionTree(input: SessionTreeInput): SessionTreeResponse {
  const { todoId, sessions } = input;
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const children = childIndex(sessions);

  const roots = sessions
    .filter((session) => session.workItemId === todoId)
    .sort((a, b) => String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? '')))
    .map((session) => nodeFor(session, todoId));

  const state: WalkState = { visited: new Set(roots.map((node) => node.id)), truncated: { depth: false, count: false }, nodes: roots.length };
  let frontier: SessionTreeNode[] = roots;
  for (let depth = 1; frontier.length > 0; depth += 1) {
    if (depth > SESSION_TREE_MAX_DEPTH) {
      markDepthBound(frontier, children, state);
      break;
    }
    frontier = expand(frontier, children, todoId, state);
  }
  const { visited, truncated } = state;

  const directory: Record<string, SessionDirectoryEntry> = {};
  for (const id of [...visited, ...(input.referencedSessionIds ?? [])]) {
    if (directory[id]) continue;
    const session = byId.get(id);
    directory[id] = session ? directoryEntry(session) : missingDirectoryEntry(id);
  }

  const live = [...visited].filter((id) => {
    const status = byId.get(id)?.status;
    return status ? LIVE_STATUSES.has(status) : false;
  }).length;

  return { roots, directory, truncated, totals: { nodes: state.nodes, live } };
}

/** Strip the `session:` actor prefix the Todo's comments and audit events carry.
 *  Anything that is not a session actor yields null and is ignored. */
export function sessionIdFromActor(actor: string | null | undefined): string | null {
  if (typeof actor !== 'string' || !actor.startsWith('session:')) return null;
  const id = actor.slice('session:'.length).trim();
  return id || null;
}

/**
 * The route-facing read: gather what the Todo names, then walk.
 *
 * `listSessions()` is the same whole-table read `serializeSessionList` already
 * performs on this route to build the delegated-activity index, so the tree
 * shape costs no extra query — it replaces that work rather than adding to it.
 */
export function readTodoSessionTree(todoId: string): SessionTreeResponse {
  const item = getWorkItem(todoId);
  const referenced = new Set<string>();
  const add = (actor: string | null | undefined) => {
    const id = sessionIdFromActor(actor);
    if (id) referenced.add(id);
  };
  add(item?.createdBy);
  for (const comment of listComments(todoId, { limit: 200 }).comments) {
    add(comment.author);
    if (comment.sessionId) referenced.add(comment.sessionId);
  }
  for (const event of listWorkItemEvents(todoId)) add(event.actor);
  return buildSessionTree({ todoId, sessions: listSessions(), referencedSessionIds: [...referenced] });
}
