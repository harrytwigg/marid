import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { initDb } from '../shared/db.js';
import { loadConfig } from '../shared/config.js';
import { CONFIG_PATH } from '../shared/paths.js';
import { assertTodoDepartmentAllowed, resolveTodoDepartmentPolicy, type TodoDepartmentPolicy } from '../shared/todo-departments-config.js';
import { parseTodoId, resolveTodoIdPrefix } from './id.js';
import { resolveDepartmentPrefix } from './departments.js';
import { allocateWorkItemId, useWorkItemAllocationClaim } from './migrate.js';
import { createdEventDetail, type WriteOrigin } from './origin.js';
import { HOME_SCOPE_SQL, KEPT_EXISTS_SQL } from './kept.js';
import { sprintFilterCondition } from './sprints-schema.js';
import { toWorkItemLinkRole, type WorkItemLinkRole } from './link-role.js';
import { searchWorkItemIds, workItemMatchReasons, type WorkItemMatch } from './search.js';
import type { WorkItemEventKind } from './event-log.js';
import { OPERATOR_ASSIGNEE, UNASSIGNED_FILTER } from './operator-assignee.js';

/**
 * Work-item store — the substrate of the Todos ledger (GRS-002, elevated by
 * GRS-021a design §1).
 *
 * A work item ("Todo" in surface language) is the durable unit of intended
 * work; a session is one execution attempt against it (linked via the nullable
 * `sessions.work_item_id` FK). This module and the guarded
 * `work-items/transitions.ts` are the ONLY write paths.
 *
 * GRS-021a additions: the 8-status vocabulary + 7-value provenance enum
 * (`migrate.ts` owns the DDL + rebuild), rounds, budget (spend is NEVER
 * stored — always derived live from linked sessions' total_cost), and the
 * append-only `work_item_events` audit.
 *
 * The `acceptance` and `verify_policy` columns are retired: they stay in the
 * DDL so existing rows keep their data, but nothing reads or writes them.
 * Acceptance criteria belong in the body.
 *
 * Trust the DB, not just TS callers: status/priority/source are enforced by
 * CHECK constraints and machine-minted idempotency by a partial UNIQUE index
 * (DDL in `migrate.ts`).
 */

/** The statuses the gateway writes. The CHECK still admits the retired `assigned`
 *  and `escalated`; the boot migration (`retired-statuses.ts`) moves those rows. */
export type WorkItemStatus =
  | 'backlog'
  | 'executing'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'cancelled';
export type WorkItemSource = 'human' | 'delegation' | 'cron' | 'workflow' | 'session' | 'connector' | 'goal';

/** Statuses that close an item — writes stamp/clear `closed_at` on these. */
const CLOSED_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(['done', 'cancelled']);
/** Sticky terminals (design §1.1): the reconciler never derives an item OUT of
 *  these, and leaving one is the operator's decision — `done`/`cancelled` are
 *  decisions, not states session churn may undo. */
export const STICKY_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(['done', 'cancelled']);

/** Whether a clean settle closes the item without operator review. Machine
 *  pulses (one cron fire each) are trusted; everything a mind delegates or
 *  captures goes to the operator, legacy `workflow` provenance included. */
export function autoClosesOnSuccess(item: Pick<WorkItem, 'source'>): boolean {
  return item.source === 'cron';
}

export interface WorkItem {
  id: string;
  title: string;
  body: string | null;
  status: WorkItemStatus;
  department: string | null;
  assignee: string | null;
  /** Who asked for this item: 'operator', an employee slug, or 'system'. */
  createdBy: string;
  /** Sub-task tree (Todos v2): parent link, denormalized root, and depth 0..3. */
  parentId: string | null;
  rootId: string;
  depth: number;
  dueAt: string | null;
  priority: number;
  /** Nullable manual order key. Lower ranked values render first. */
  rank: number | null;
  /** Monotonic row revision used for whole-Todo optimistic concurrency. */
  version: number;
  source: WorkItemSource;
  sourceRef: string | null;
  /** Times the operator has sent this item back from review. A count only:
   *  nothing caps it. */
  rounds: number;
  budgetUsd: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface CreateWorkItemInput {
  title: string;
  body?: string | null;
  status?: WorkItemStatus;
  department?: string | null;
  assignee?: string | null;
  /** Creator identity; defaults to 'operator' for source=human, 'system' otherwise. */
  createdBy?: string;
  /** Create as a sub-task of an existing Todo (depth ≤ 3). Department is
   *  inherited from the parent when not given explicitly. */
  parentId?: string | null;
  /** Optional ISO 8601 deadline. */
  dueAt?: string | null;
  priority?: number;
  source?: WorkItemSource;
  /**
   * Stable key for machine-minted items (e.g. `cron:<jobId>:<fireIso>`,
   * `workflow:<defId>:<runId>`). When set, `createWorkItem` is idempotent on
   * `(source, sourceRef)` — a repeat insert returns the existing row instead of
   * creating a duplicate. NULL refs never collide.
   */
  sourceRef?: string | null;
  budgetUsd?: number | null;
  origin?: WriteOrigin;
}

export interface ListWorkItemsFilter {
  status?: WorkItemStatus;
  department?: string;
  assignee?: string;
  source?: WorkItemSource;
  needsAttentionFor?: string;
  /** The queue is the operator's own: blocked Todos assigned to `@operator`, or to nobody, count too. */
  needsAttentionOperator?: boolean;
  /** Exact creator identity (`created_by`). */
  createdBy?: string;
  /** Direct children of this Todo. */
  parentId?: string;
  /** Whole family sharing this root Todo. */
  rootId?: string;
  /** Only tree roots (parentless items). */
  rootsOnly?: boolean;
  /** Board scopes — `kept`: pinned (ICI-1357). `home`: pinned OR operator-created (PLA-230). */
  kept?: boolean;
  home?: boolean;
  /** Items carrying this label, matched by exact label id (`lbl_…`) or stored
   *  (normalized kebab-case) name — callers normalize display names first. */
  label?: string;
  /** Items in this sprint (a sub-task reads its root's): id, name, `active` or `none`. */
  sprint?: string;
  /** Free text, matched by the FTS5 indexes over title, body and comments. Relevance-ordered, exact Todo id first. */
  text?: string;
  /** Inclusive ISO timestamp bounds over `updated_at`. */
  since?: string;
  until?: string;
  /** Cap rows in SQL (LIMIT) instead of the caller slicing after a full-table load. */
  limit?: number;
  /** Zero-based row offset, applied after the canonical ordering. */
  offset?: number;
}

export interface SearchWorkItemsFilter extends ListWorkItemsFilter {}

export type WorkItemTotals = Record<WorkItemStatus, number>;

export interface WorkItemPage {
  workItems: WorkItem[];
  /** Exact count matching the filters, before LIMIT/OFFSET. */
  total: number;
  /** Exact matching counts by raw stored status, before LIMIT/OFFSET. */
  totals: WorkItemTotals;
  limit: number;
  offset: number;
  nextOffset: number | null;
  /** Why each returned Todo matched, best reason first, keyed by Todo id.
   *  Present only when the query carried `text`. */
  matches?: Record<string, WorkItemMatch[]>;
}

function rowToWorkItem(row: Record<string, unknown>): WorkItem {
  return {
    id: row.id as string,
    title: row.title as string,
    body: (row.body as string) ?? null,
    status: row.status as WorkItemStatus,
    department: (row.department as string) ?? null,
    assignee: (row.assignee as string) ?? null,
    createdBy: row.created_by as string,
    parentId: (row.parent_id as string) ?? null,
    rootId: row.root_id as string,
    depth: (row.depth as number) ?? 0,
    dueAt: (row.due_at as string) ?? null,
    priority: row.priority as number,
    rank: (row.rank as number) ?? null,
    version: row.version as number,
    source: row.source as WorkItemSource,
    sourceRef: (row.source_ref as string) ?? null,
    rounds: (row.rounds as number) ?? 0,
    budgetUsd: (row.budget_usd as number) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    closedAt: (row.closed_at as string) ?? null,
  };
}

/** True only for a UNIQUE-constraint violation — NOT a CHECK violation (those must
 *  still surface as errors, e.g. an invalid status). better-sqlite3 sets `.code`. */
function isUniqueConstraintError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/* ── Events (append-only audit, design §1.2) ────────────────────────────────── */

export interface WorkItemEvent {
  id: string;
  workItemId: string;
  kind: WorkItemEventKind;
  fromStatus: WorkItemStatus | null;
  toStatus: WorkItemStatus | null;
  actor: string | null;
  /** Parsed JSON payload (critique text, session id, policy note, …). */
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface AppendWorkItemEventInput {
  workItemId: string;
  kind: WorkItemEventKind;
  fromStatus?: WorkItemStatus | null;
  toStatus?: WorkItemStatus | null;
  actor?: string | null;
  detail?: Record<string, unknown> | null;
  /** `state` advances the Todo revision for a standalone operator-visible note
   * or verification result. `companion` records the audit for a row mutation
   * that already advanced it. `audit` is telemetry/visibility only. */
  versionEffect?: 'state' | 'companion' | 'audit';
}

/** Append one audit event. Callers inside a transaction compose naturally
 *  (better-sqlite3 nests via savepoints). Never throws on payload shape — the
 *  detail is stringified verbatim. */
export function appendWorkItemEvent(input: AppendWorkItemEventInput): WorkItemEvent {
  const db = initDb();
  const workItemId = parseTodoId(input.workItemId);
  const now = new Date().toISOString();
  const event: WorkItemEvent = {
    id: `wie_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    workItemId,
    kind: input.kind,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    actor: input.actor ?? null,
    detail: input.detail ?? null,
    createdAt: now,
  };
  const versionEffect = input.versionEffect
    ?? (input.kind === 'note' || input.kind === 'verify_result' ? 'state' : 'companion');
  const txn = db.transaction((): WorkItemEvent => {
    if (versionEffect === 'state') {
      const touched = db.prepare('UPDATE work_items SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, input.workItemId);
      if (touched.changes === 0) throw new Error('cannot append state event for an unknown Todo');
    }
    db.prepare(
      `INSERT INTO work_item_events (id, work_item_id, kind, from_status, to_status, actor, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.workItemId,
      event.kind,
      event.fromStatus,
      event.toStatus,
      event.actor,
      event.detail ? JSON.stringify(event.detail) : null,
      event.createdAt,
    );
    return event;
  });
  return txn();
}

/** Reading the trail back lives in event-log.ts, along with the actors whose
 *  writes are derived rather than declared. Re-exported here so the audit
 *  surface stays one import for every caller. */
export {
  RECONCILER_ACTOR,
  WORKFLOW_RUN_ACTOR,
  isBlockDeclared,
  isReviewBounceDeclared,
  listWorkItemEvents,
  listWorkItemEventsForItems,
} from './event-log.js';
export type { WorkItemEventKind } from './event-log.js';

/* ── Create / read ──────────────────────────────────────────────────────────── */

/**
 * Create a work item (status defaults to `backlog`, source to `human`).
 * Idempotent for machine-minted items: when `sourceRef` is set and a row already
 * exists for that `(source, sourceRef)` pair, the existing row is returned
 * unchanged — a repeat for the same key never duplicates AND never re-appends a
 * `created` event. The check+insert(+event) runs in one transaction; if a
 * concurrent writer wins the `(source, source_ref)` race between our SELECT and
 * INSERT, the UNIQUE violation is caught and we re-select the winner's row.
 * Invalid enum values are rejected by the table's CHECK constraints.
 */
export function createWorkItem(input: CreateWorkItemInput): WorkItem {
  const db = initDb();
  const now = new Date().toISOString();
  // The burn commits before the create. An idempotent hit or a lost race discards the
  // claim and leaves a permanent gap in the company Todo sequence, which is valid by design.
  // A configless disposable/test home retains the historical JIN default. Once a
  // real config exists, malformed configuration must still fail closed rather than
  // silently allocating from the wrong company namespace.
  let parent: WorkItem | undefined;
  if (input.parentId) {
    parent = getWorkItem(input.parentId);
    if (!parent) throw new Error(`parent Todo ${input.parentId} not found`);
    // Closed parents refuse new children (the roll-up gate would otherwise be
    // violable by construction order). A blocked parent stays creatable-under:
    // decomposing it into sub-tasks is a legitimate part of resolving it.
    if (parent.status === 'done' || parent.status === 'cancelled') {
      throw new Error(`parent Todo ${parent.id} is ${parent.status} — sub-tasks cannot be added under a closed Todo`);
    }
    if (parent.depth >= 3) {
      throw new Error(`parent Todo ${parent.id} is at depth ${parent.depth} — the sub-task tree is capped at depth 3`);
    }
  }
  const companyPrefix = resolveCompanyPrefix();
  const departmentPolicy = resolveTodoDepartments();
  // Only a department the caller names is checked: a sub-task inheriting a
  // parent classified before the policy existed stays with its parent. Under a
  // policy with a default, nothing lands unclassified in the company namespace.
  if (input.department !== undefined) assertTodoDepartmentAllowed(departmentPolicy, input.department);
  const named = input.department !== undefined ? input.department : parent?.department ?? null;
  const department = named ?? departmentPolicy?.defaultDepartment ?? null;
  const prefix = department ? resolveDepartmentPrefix(db, department, companyPrefix) : companyPrefix;
  const claim = allocateWorkItemId(db, now, prefix);
  const id = claim.id;
  const status: WorkItemStatus = input.status ?? 'backlog';
  const source: WorkItemSource = input.source ?? 'human';
  const sourceRef = input.sourceRef ?? null;
  const priority = input.priority ?? 2;
  const closedAt = CLOSED_STATUSES.has(status) ? now : null;
  const createdBy = input.createdBy ?? (source === 'human' ? 'operator' : 'system');

  const selectExisting = (): WorkItem | undefined => {
    const row = db
      .prepare('SELECT * FROM work_items WHERE source = ? AND source_ref = ?')
      .get(source, sourceRef) as Record<string, unknown> | undefined;
    return row ? rowToWorkItem(row) : undefined;
  };

  const txn = db.transaction((): WorkItem => {
    if (sourceRef !== null) {
      const existing = selectExisting();
      if (existing) return existing;
    }
    try {
      db.prepare(
        `INSERT INTO work_items
           (id, title, body, status, department, assignee, created_by, parent_id, root_id, depth, due_at,
            priority, source, source_ref, budget_usd, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.title,
        input.body ?? null,
        status,
        department,
        input.assignee ?? null,
        createdBy,
        parent?.id ?? null,                       // parent_id
        parent ? parent.rootId : id,              // root_id
        parent ? parent.depth + 1 : 0,            // depth
        input.dueAt ?? null,
        priority,
        source,
        sourceRef,
        input.budgetUsd ?? null,
        now,
        now,
        closedAt,
      );
    } catch (err) {
      // Lost the idempotency race — another writer inserted the same key. Return
      // theirs rather than surfacing a constraint error. CHECK violations (bad
      // status/priority/source) are NOT unique errors, so they still throw.
      if (sourceRef !== null && isUniqueConstraintError(err)) {
        const existing = selectExisting();
        if (existing) return existing;
      }
      throw err;
    }
    appendWorkItemEvent({ workItemId: id, kind: 'created', toStatus: status, actor: source, detail: createdEventDetail(sourceRef, input.origin) });
    if (parent) {
      // Re-verify the parent under the write lock before auditing the link.
      const liveParent = db.prepare('SELECT depth FROM work_items WHERE id = ?').get(parent.id) as { depth: number } | undefined;
      if (!liveParent) throw new Error(`parent Todo ${parent.id} disappeared during create`);
      appendWorkItemEvent({
        workItemId: parent.id,
        kind: 'child_created',
        actor: input.createdBy ?? source,
        detail: { childId: id },
        versionEffect: 'state',   // bump the parent so tree views resort
      });
    }
    return getWorkItem(id)!;
  });
  return useWorkItemAllocationClaim(db, claim, () => txn());
}

/** The company Todo namespace: derived from configured company name, or the
 *  explicit `portal.companyPrefix` override; configless homes keep `JIN`. */
export function resolveCompanyPrefix(): string {
  const portal = fs.existsSync(CONFIG_PATH) ? loadConfig().portal : undefined;
  return resolveTodoIdPrefix(portal?.companyName ?? 'Jinn', portal?.companyPrefix);
}

/** The closed-department policy (`gateway.todoDepartments`, JIN-1), or null
 *  when departments are open — including in a configless home, or a config
 *  with no `gateway:` block, which validateConfigShape allows. */
export function resolveTodoDepartments(): TodoDepartmentPolicy | null {
  return fs.existsSync(CONFIG_PATH) ? resolveTodoDepartmentPolicy(loadConfig().gateway?.todoDepartments) : null;
}

/** Register a department in the registry if it is not there yet (review F2):
 *  EVERY write that lands a non-null department calls this inside its own
 *  transaction, so /api/departments can never omit a department that holds
 *  live Todos. Items keep their birth ID prefix — this only mints the row. */
export function ensureDepartmentRegistered(slug: string | null | undefined): void {
  if (typeof slug !== 'string' || !slug) return;
  resolveDepartmentPrefix(initDb(), slug, resolveCompanyPrefix());
}

export function getWorkItem(id: string): WorkItem | undefined {
  const db = initDb();
  const todoId = parseTodoId(id);
  const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(todoId) as Record<string, unknown> | undefined;
  return row ? rowToWorkItem(row) : undefined;
}

/** Read a bounded set of Todos in caller order with one row query. Unknown
 * ids are omitted. */
export function getWorkItems(ids: readonly string[]): WorkItem[] {
  const requestedIds = [...new Set(ids.map((id) => parseTodoId(id)))];
  if (requestedIds.length === 0) return [];
  const db = initDb();
  const placeholders = requestedIds.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT * FROM work_items WHERE id IN (${placeholders})`)
    .all(...requestedIds) as Record<string, unknown>[];
  const byId = new Map(rows.map(rowToWorkItem).map((item) => [item.id, item]));
  return requestedIds.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

/** Look up a machine-minted item by its stable key — how the workflow bridge
 *  resolves a run's Todo without threading ids through the driver. */
export function getWorkItemBySourceRef(source: WorkItemSource, sourceRef: string): WorkItem | undefined {
  const db = initDb();
  const row = db
    .prepare('SELECT * FROM work_items WHERE source = ? AND source_ref = ?')
    .get(source, sourceRef) as Record<string, unknown> | undefined;
  return row ? rowToWorkItem(row) : undefined;
}

export const WORK_ITEM_STATUS_VALUES: readonly WorkItemStatus[] = [
  'backlog',
  'executing',
  'in_review',
  'done',
  'blocked',
  'cancelled',
];

/** Filter keys that are a plain equality on the column they name. */
const EQUALITY_FILTERS = [['status', 'status'], ['department', 'department'], ['assignee', 'assignee'],
  ['source', 'source'], ['createdBy', 'created_by']] as const;

function workItemWhere(filter: ListWorkItemsFilter, textIds?: readonly string[]): { sql: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (textIds) {
    conditions.push('work_items.id IN (SELECT value FROM json_each(?))');
    values.push(JSON.stringify(textIds));
  }
  for (const [key, column] of EQUALITY_FILTERS) {
    const value = filter[key];
    if (!value) continue;
    if (key === 'assignee' && value === UNASSIGNED_FILTER) {
      conditions.push(`${column} IS NULL`);
      continue;
    }
    conditions.push(`${column} = ?`);
    values.push(value);
  }
  if (filter.parentId) {
    conditions.push('parent_id = ?');
    values.push(parseTodoId(filter.parentId));
  }
  if (filter.rootId) {
    conditions.push('root_id = ?');
    values.push(parseTodoId(filter.rootId));
  }
  if (filter.rootsOnly) conditions.push('parent_id IS NULL');
  if (filter.kept) conditions.push(KEPT_EXISTS_SQL);
  if (filter.home) conditions.push(HOME_SCOPE_SQL);
  if (filter.label) {
    conditions.push(
      'EXISTS (SELECT 1 FROM work_item_labels wil JOIN labels l ON l.id = wil.label_id WHERE wil.work_item_id = work_items.id AND (l.id = ? OR l.name = ?))',
    );
    values.push(filter.label, filter.label);
  }
  if (filter.sprint) {
    const sprint = sprintFilterCondition(filter.sprint);
    conditions.push(sprint.sql);
    values.push(...sprint.values);
  }
  if (filter.needsAttentionFor) {
    // A blocked Todo held by the caller, or one recovery routed to a human; the operator's own queue
    // adds blocked Todos held by @operator or by nobody (a Dispatcher or Shaper dead end). An unexpired
    // park is a clock-wait (PLA-157) and leaves this set outright; an unreadable one is not a park.
    // A recovery row only counts while the Todo is in a status the sweep visits — the sweep
    // statuses are RECOVERY_SWEPT_STATUSES in work-items/recovery.ts; keep this list in step with it.
    conditions.push(
      "((((assignee IN (?, ?) OR (? = 1 AND assignee IS NULL)) AND status = 'blocked') OR EXISTS (SELECT 1 FROM work_item_recovery rec WHERE rec.work_item_id = work_items.id AND rec.lane IN ('recovering', 'manager') AND work_items.status IN ('executing', 'in_review', 'blocked'))) AND NOT EXISTS (SELECT 1 FROM work_item_stop_cause sc WHERE sc.work_item_id = work_items.id AND strftime('%s', sc.parked_until) > strftime('%s', ?) AND NOT EXISTS (SELECT 1 FROM work_item_recovery rec2 WHERE rec2.work_item_id = work_items.id AND rec2.lane IN ('recovering', 'manager'))))",
    );
    values.push(filter.needsAttentionFor, filter.needsAttentionOperator ? OPERATOR_ASSIGNEE : filter.needsAttentionFor, filter.needsAttentionOperator ? 1 : 0, new Date().toISOString());
  }
  if (filter.since) {
    conditions.push('updated_at >= ?');
    values.push(filter.since);
  }
  if (filter.until) {
    conditions.push('updated_at <= ?');
    values.push(filter.until);
  }
  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  };
}

/** Paginated, deterministic AND-composed Todo query. Counts are computed from
 * the identical WHERE clause before pagination, so a capped page can never
 * masquerade as the full ledger. */
export function queryWorkItems(filter: ListWorkItemsFilter = {}): WorkItemPage {
  const db = initDb();
  const textIds = filter.text ? searchWorkItemIds(db, filter.text) : null;
  const { sql: where, values } = workItemWhere(filter, textIds ?? undefined);
  const limit = typeof filter.limit === 'number' && Number.isFinite(filter.limit)
    ? Math.max(0, Math.floor(filter.limit))
    : 20;
  const offset = typeof filter.offset === 'number' && Number.isFinite(filter.offset)
    ? Math.max(0, Math.floor(filter.offset))
    : 0;
  // Relevance leads only when text was given; otherwise the order is byte-identical to before, and it still breaks relevance ties.
  const relevance = textIds ? '(SELECT key FROM json_each(?) WHERE value = work_items.id) ASC, ' : '';
  const orderValues = textIds ? [JSON.stringify(textIds)] : [];
  const rows = db
    .prepare(`SELECT * FROM work_items ${where} ORDER BY ${relevance}(rank IS NULL) ASC, rank ASC, updated_at DESC, created_at DESC, id ASC LIMIT ? OFFSET ?`)
    .all(...values, ...orderValues, limit, offset) as Record<string, unknown>[];
  const counts = db
    .prepare(`SELECT status, COUNT(*) AS total FROM work_items ${where} GROUP BY status`)
    .all(...values) as Array<{ status: WorkItemStatus; total: number }>;
  const totals = Object.fromEntries(WORK_ITEM_STATUS_VALUES.map((status) => [status, 0])) as WorkItemTotals;
  for (const count of counts) totals[count.status] = count.total;
  const total = counts.reduce((sum, count) => sum + count.total, 0);
  const workItems = rows.map(rowToWorkItem);
  const consumed = offset + workItems.length;
  const page: WorkItemPage = {
    workItems,
    total,
    totals,
    limit,
    offset,
    nextOffset: workItems.length > 0 && consumed < total ? consumed : null,
  };
  // Reasons are asked for the page, not for the whole match set: `snippet()` is
  // the expensive half, and only the rows actually returned need one.
  if (filter.text) page.matches = workItemMatchReasons(db, filter.text, workItems.map((item) => item.id));
  return page;
}

/** List work items, recently-updated first, optionally filtered. Compatibility
 * wrapper: an omitted limit still means the full matching set. */
export function listWorkItems(filter?: ListWorkItemsFilter): WorkItem[] {
  return queryWorkItems({ ...(filter ?? {}), limit: filter?.limit ?? 2_147_483_647 }).workItems;
}

/** Deterministic AND-composed Todo search (GRS-021c). */
export function searchWorkItems(filter: SearchWorkItemsFilter, limit = 20): WorkItem[] {
  if (!filter.text && !filter.status && !filter.source && !filter.assignee && !filter.department && !filter.needsAttentionFor && !filter.since && !filter.until) {
    throw new Error('searchWorkItems requires at least one filter');
  }
  return queryWorkItems({ ...filter, limit }).workItems;
}

export type WorkItemTreeNode = WorkItem & { children: WorkItemTreeNode[] };

export interface WorkItemTree {
  root: WorkItemTreeNode;
  /** Status counts over the returned subtree (root included). */
  totals: WorkItemTotals;
  /** Live derived spend over every session linked anywhere in the subtree. */
  spendUsd: number;
}

/** Read multiple work-item subtrees without query fan-out. One indexed query
 *  fetches every requested family via root_id, then one grouped session query
 *  fetches spend for those families; each requested subtree is assembled and
 *  totalled in memory. Unknown IDs are omitted from the returned record. */
export function getWorkItemTrees(ids: readonly string[]): Record<string, WorkItemTree> {
  const requestedIds = [...new Set(ids.map((id) => parseTodoId(id)))];
  if (requestedIds.length === 0) return {};
  const db = initDb();
  const placeholders = requestedIds.map(() => '?').join(', ');
  const requestedRoots = `SELECT root_id FROM work_items WHERE id IN (${placeholders})`;
  const family = (db
    .prepare(`SELECT * FROM work_items WHERE root_id IN (${requestedRoots})`)
    .all(...requestedIds) as Record<string, unknown>[])
    .map(rowToWorkItem);
  if (family.length === 0) return {};
  const itemsById = new Map(family.map((item) => [item.id, item]));
  const childrenByParent = new Map<string, WorkItem[]>();
  for (const member of family) {
    if (!member.parentId) continue;
    const siblings = childrenByParent.get(member.parentId) ?? [];
    siblings.push(member);
    childrenByParent.set(member.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.id.localeCompare(b.id));
  }
  const build = (node: WorkItem): WorkItemTreeNode => ({
    ...node,
    children: (childrenByParent.get(node.id) ?? []).map(build),
  });

  const spendRows = db
    .prepare(
      `SELECT sessions.work_item_id AS work_item_id, COALESCE(SUM(sessions.total_cost), 0) AS spend
       FROM sessions
       JOIN work_items ON work_items.id = sessions.work_item_id
       WHERE work_items.root_id IN (${requestedRoots})
       GROUP BY sessions.work_item_id`,
    )
    .all(...requestedIds) as Array<{ work_item_id: string; spend: number }>;
  const spendByItem = new Map(spendRows.map((row) => [row.work_item_id, row.spend]));

  const trees: Record<string, WorkItemTree> = {};
  for (const id of requestedIds) {
    const item = itemsById.get(id);
    if (!item) continue;
    const root = build(item);
    const totals = Object.fromEntries(WORK_ITEM_STATUS_VALUES.map((status) => [status, 0])) as WorkItemTotals;
    let spendUsd = 0;
    const walk = (node: WorkItemTreeNode): void => {
      totals[node.status] += 1;
      spendUsd += spendByItem.get(node.id) ?? 0;
      node.children.forEach(walk);
    };
    walk(root);
    trees[id] = { root, totals, spendUsd };
  }
  return trees;
}

/** Read one work item's subtree. The batch implementation is the source of
 *  truth so the additive batch route stays byte-for-byte shape-compatible. */
export function getWorkItemTree(id: string): WorkItemTree | undefined {
  return getWorkItemTrees([id])[id];
}

export interface UpdateWorkItemInput {
  title?: string;
  body?: string | null;
  assignee?: string | null;
  department?: string | null;
  priority?: number;
  rank?: number | null;
  /** Todos v2 slice 4 — the widened metadata pen also covers this. */
  dueAt?: string | null;
}

export interface ConditionalWorkItemUpdateOptions {
  expectedVersion: number;
  idempotencyKey?: string;
  actor?: string | null; origin?: WriteOrigin;
}

export interface ConditionalWorkItemUpdateResult {
  item: WorkItem;
  replayed: boolean;
}

export class WorkItemVersionConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super('Todo changed since it was loaded');
    this.name = 'WorkItemVersionConflictError';
    this.currentVersion = currentVersion;
  }
}

export class WorkItemIdempotencyConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super('Todo edit idempotency key was already used for a different request');
    this.name = 'WorkItemIdempotencyConflictError';
    this.currentVersion = currentVersion;
  }
}

const UPDATE_FIELD_COLUMNS: Readonly<Record<keyof UpdateWorkItemInput, string>> = {
  title: 'title',
  body: 'body',
  assignee: 'assignee',
  department: 'department',
  priority: 'priority',
  rank: 'rank',
  // Appended AFTER the original six so pre-slice-4 idempotency-receipt
  // fingerprints (key order feeds the canonical JSON) stay byte-stable.
  dueAt: 'due_at',
};

function canonicalUpdateFingerprint(id: string, input: UpdateWorkItemInput, expectedVersion: number): string {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(UPDATE_FIELD_COLUMNS) as Array<keyof UpdateWorkItemInput>) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  return createHash('sha256').update(JSON.stringify({ id, expectedVersion, patch })).digest('hex');
}

function idempotencyKeyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function updateChangesItem(item: WorkItem, input: UpdateWorkItemInput): boolean {
  return (Object.keys(UPDATE_FIELD_COLUMNS) as Array<keyof UpdateWorkItemInput>)
    .some((key) => {
      if (input[key] === undefined) return false;
      return item[key] !== input[key];
    });
}

/** Atomic row-level compare-and-update for the operator metadata surface.
 * Partial fields are patch semantics, but `expectedVersion` protects the whole
 * Todo row: any intervening editable or lifecycle mutation conflicts. An exact
 * idempotency replay is resolved before that guard and never writes again. */
export function updateWorkItemConditional(
  id: string,
  input: UpdateWorkItemInput,
  opts: ConditionalWorkItemUpdateOptions,
): ConditionalWorkItemUpdateResult | undefined {
  const db = initDb();
  const fingerprint = canonicalUpdateFingerprint(id, input, opts.expectedVersion);
  const keyDigest = opts.idempotencyKey ? idempotencyKeyDigest(opts.idempotencyKey) : undefined;
  const txn = db.transaction((): ConditionalWorkItemUpdateResult | undefined => {
    const current = getWorkItem(id);
    if (!current) return undefined;

    if (keyDigest) {
      const receipt = db
        .prepare('SELECT request_fingerprint FROM work_item_edit_receipts WHERE key_digest = ?')
        .get(keyDigest) as { request_fingerprint: string } | undefined;
      if (receipt) {
        if (receipt.request_fingerprint !== fingerprint) {
          throw new WorkItemIdempotencyConflictError(current.version);
        }
        return { item: current, replayed: true };
      }
    }

    if (current.version !== opts.expectedVersion) {
      throw new WorkItemVersionConflictError(current.version);
    }
    // Leaving a pre-policy department in place is not a reclassification.
    if (typeof input.department === 'string' && input.department !== current.department) {
      assertTodoDepartmentAllowed(resolveTodoDepartments(), input.department);
    }

    let item = current;
    if (updateChangesItem(current, input)) {
      const fields = (Object.keys(UPDATE_FIELD_COLUMNS) as Array<keyof UpdateWorkItemInput>)
        .filter((key) => input[key] !== undefined)
        .map((key) => ({ column: UPDATE_FIELD_COLUMNS[key], name: key, value: input[key] }));
      if (typeof input.department === 'string') ensureDepartmentRegistered(input.department);
      const now = new Date().toISOString();
      const result = db
        .prepare(`UPDATE work_items SET ${fields.map((field) => `${field.column} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`)
        .run(...fields.map((field) => field.value), now, id, opts.expectedVersion);
      if (result.changes === 0) {
        const latest = getWorkItem(id);
        if (!latest) return undefined;
        throw new WorkItemVersionConflictError(latest.version);
      }
      const releasedSessions = releaseOnOwnerChange(db, current, input.assignee);
      appendWorkItemEvent({
        workItemId: id,
        kind: 'metadata_edited',
        actor: opts.actor ?? null,
        detail: {
          updatedFields: fields.map((field) => field.name),
          ...(opts.origin ? { origin: opts.origin } : {}),
          ...(releasedSessions.length > 0 ? { releasedSessions } : {}),
        },
        versionEffect: 'companion',
      });
      item = getWorkItem(id)!;
    }

    if (keyDigest) {
      db.prepare(
        `INSERT INTO work_item_edit_receipts (key_digest, request_fingerprint, result_version, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(keyDigest, fingerprint, item.version, new Date().toISOString());
    }
    return { item, replayed: false };
  });
  return txn.immediate();
}

/** Internal compatibility write for migration and trusted non-HTTP callers.
 * Public operator edits use updateWorkItemConditional. Status is deliberately
 * absent: lifecycle changes belong to the guarded transitions module. */
export function updateWorkItem(id: string, input: UpdateWorkItemInput, actor?: string | null): WorkItem | undefined {
  const db = initDb();
  const fields: Array<{ column: string; name: keyof UpdateWorkItemInput; value: unknown }> = [];
  if (input.title !== undefined) fields.push({ column: 'title', name: 'title', value: input.title });
  if (input.body !== undefined) fields.push({ column: 'body', name: 'body', value: input.body });
  if (input.assignee !== undefined) fields.push({ column: 'assignee', name: 'assignee', value: input.assignee });
  if (input.department !== undefined) fields.push({ column: 'department', name: 'department', value: input.department });
  if (input.priority !== undefined) fields.push({ column: 'priority', name: 'priority', value: input.priority });
  if (input.rank !== undefined) fields.push({ column: 'rank', name: 'rank', value: input.rank });
  if (fields.length === 0) return getWorkItem(id);

  const txn = db.transaction((): WorkItem | undefined => {
    const current = getWorkItem(id);
    if (!current) return undefined;
    const changedFields = fields.filter((field) => current[field.name] !== field.value);
    if (changedFields.length === 0) return current;
    if (changedFields.some((field) => field.name === 'department' && typeof field.value === 'string')) {
      ensureDepartmentRegistered(input.department as string);
    }
    const now = new Date().toISOString();
    const result = db
      .prepare(`UPDATE work_items SET ${changedFields.map((field) => `${field.column} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`)
      .run(...changedFields.map((field) => field.value), now, id);
    if (result.changes === 0) return undefined;
    const releasedSessions = releaseOnOwnerChange(db, current, input.assignee);
    appendWorkItemEvent({
      workItemId: id,
      kind: 'note',
      actor: actor ?? null,
      detail: { updatedFields: changedFields.map((field) => field.name), ...(releasedSessions.length > 0 ? { releasedSessions } : {}) },
      versionEffect: 'companion',
    });
    return getWorkItem(id);
  });
  return txn();
}

/** Live spend over an item's execution attempts: `SUM(total_cost)` across linked
 *  sessions. Never stored (design §1.6) — always derived, never stale. */
export function getWorkItemSpend(id: string): number {
  const db = initDb();
  const workItemId = parseTodoId(id);
  const row = db
    .prepare('SELECT COALESCE(SUM(total_cost), 0) AS spend FROM sessions WHERE work_item_id = ?')
    .get(workItemId) as { spend: number };
  return row.spend;
}

/* ── Link + raw status write ────────────────────────────────────────────────── */

/**
 * Link an execution attempt (session) to a work item. Touches two rows
 * (`sessions.work_item_id` + `work_items.updated_at`) so it runs in one
 * transaction: if the work item does not exist, the session write is rolled back
 * and nothing is half-linked. Throws when either the session or the work item is
 * missing. Appends a `session_linked` audit event on an ACTUAL write.
 *
 * Idempotent-in-writes: if the session already carries this exact `work_item_id`,
 * the call verifies both rows exist and then returns WITHOUT writing — so a
 * redundant re-link (e.g. a cron re-fire re-linking the same item to the same session)
 * does not churn `work_items.updated_at` or the event log.
 *
 * `selfStarted` marks the link as one a session made by starting its own Todo
 * with no dispatch (`gateway/todo-self-start.ts`); any other link clears the
 * mark. A marked link holds only while the Todo is being worked: the move that
 * puts the Todo back in the backlog releases it ({@link releaseSelfStartedLinks}).
 */
export function linkSession(
  workItemId: string,
  sessionId: string,
  actor?: string | null,
  role: WorkItemLinkRole = 'execute',
  opts: { selfStarted?: boolean } = {},
): void {
  const db = initDb();
  const todoId = parseTodoId(workItemId);
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    const session = db
      .prepare('SELECT work_item_id, work_item_role FROM sessions WHERE id = ?')
      .get(sessionId) as { work_item_id: string | null; work_item_role: string | null } | undefined;
    if (!session) throw new Error(`linkSession: session ${sessionId} not found`);
    const workItemExists = db.prepare('SELECT 1 FROM work_items WHERE id = ?').get(todoId);
    if (!workItemExists) throw new Error(`linkSession: work item ${todoId} not found`);
    // Already linked to this exact item, for the same reason → no write, no
    // `updated_at` bump. A re-link that CHANGES the role still writes: the role
    // is what the self-review ban reads, and a stale one is not a detail.
    if (session.work_item_id === todoId && toWorkItemLinkRole(session.work_item_role) === role) return;
    const meta = opts.selfStarted
      ? `json_set(COALESCE(transport_meta, '{}'), '$.${SELF_STARTED_META_KEY}', ?)`
      : `json_remove(transport_meta, '$.${SELF_STARTED_META_KEY}')`;
    db.prepare(`UPDATE sessions SET work_item_id = ?, work_item_role = ?, transport_meta = ${meta} WHERE id = ?`)
      .run(todoId, role, ...(opts.selfStarted ? [todoId] : []), sessionId);
    db.prepare('UPDATE work_items SET updated_at = ?, version = version + 1 WHERE id = ?').run(now, todoId);
    appendWorkItemEvent({
      workItemId: todoId,
      kind: 'session_linked',
      actor,
      detail: { sessionId, role, ...(opts.selfStarted ? { selfStarted: true } : {}) },
    });
  });
  txn();
}

/** The session meta key naming the Todo a session linked itself to by starting it. */
export const SELF_STARTED_META_KEY = 'selfStartedTodo';

/**
 * Release the self-started links on a Todo that is going back to the backlog
 * or to another owner, and return the sessions released. Called inside the
 * status or assignment write's own transaction; `exceptEmployee` keeps the
 * links of the employee the Todo now belongs to.
 *
 * A chat session that started its own Todo keeps running turns after the Todo
 * is put down, by the agent or by the operator, and a linked session in flight
 * derives `executing`: left linked, every later turn would pull a parked Todo
 * back to work. A dispatched attempt's link is not marked and is left alone.
 * The session's run stays on the Todo's ledger and settles with the session.
 */
export function releaseSelfStartedLinks(
  db: ReturnType<typeof initDb>,
  workItemId: string,
  { exceptEmployee }: { exceptEmployee?: string } = {},
): string[] {
  const rows = db
    .prepare(`SELECT id FROM sessions WHERE work_item_id = ? AND json_extract(transport_meta, '$.${SELF_STARTED_META_KEY}') = ?
      AND (? IS NULL OR employee IS NULL OR employee <> ?)`)
    .all(workItemId, workItemId, exceptEmployee ?? null, exceptEmployee ?? null) as { id: string }[];
  const release = db.prepare(
    `UPDATE sessions SET work_item_id = NULL, work_item_role = NULL, transport_meta = json_remove(transport_meta, '$.${SELF_STARTED_META_KEY}') WHERE id = ?`,
  );
  for (const row of rows) release.run(row.id);
  return rows.map((row) => row.id);
}

/** The self-started links an assignee write releases: none unless it changed
 *  the assignee. Every writer of `assignee` calls this, in its own transaction,
 *  so a Todo given to someone else — or to nobody — never keeps the old owner's
 *  chat as its executor. */
function releaseOnOwnerChange(db: ReturnType<typeof initDb>, current: WorkItem, assignee: string | null | undefined): string[] {
  if (assignee === undefined || assignee === current.assignee) return [];
  return releaseSelfStartedLinks(db, current.id, { exceptEmployee: assignee ?? undefined });
}
