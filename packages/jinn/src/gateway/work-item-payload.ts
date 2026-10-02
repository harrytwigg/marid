import { getWorkItemSpend, listWorkItemEvents, type queryWorkItems, type WorkItem } from "../work-items/store.js";
import { commentsTail } from "../work-items/comments.js";
import { blockedSet, isBlocked, listRelations } from "../work-items/relations.js";
import { getWorkItemLabels, labelSets, type Label } from "../work-items/labels.js";
import { listWorkItemRuns } from "../work-items/runs.js";
import { getTodoDispatchConfig } from "../work-items/dispatch-config.js";
import { readStopCause, type TodoStopCause } from "../work-items/stop-cause.js";
import { isWorkItemKept, keptSet } from "../work-items/kept.js";
import { getWorkItemRecovery, recoveryByItem } from "../work-items/recovery-rows.js";
import { isRecoverySweptStatus } from "../work-items/recovery.js";
import { initDb } from "../shared/db.js";

/** The wire projections of a Todo the API routes return: one compact shape for
 *  lists, one enriched shape for the board, one full shape for the detail route. */

/** Compact wire summary (Todos v2 slice 3 adds `labels` + `blocked` — the
 *  board's chip/indicator data; ICI-1357 adds `kept` — whether the Todo is on
 *  the operator's Home). List callers pass the pre-batched `extras` (ONE query
 *  each per page); single-item callers omit them and pay per-item lookups. */
function attentionLaneOf(
  item: WorkItem,
  recovery = getWorkItemRecovery(item.id),
): string | null {
  // the recovery sweep only visits RECOVERY_SWEPT_STATUSES, so a row
  // left behind by a move to backlog (or a terminal) is stale — reading it here
  // kept a lane the Todo no longer had a reason for.
  if (recovery && isRecoverySweptStatus(item.status)) return recovery.lane;
  if (item.status === "blocked") {
    const cause = readStopCause(initDb(), item.id);
    if (cause?.parkedUntil) return "recovering";
    return "operator";
  }
  return null;
}

export function compactWorkItem(
  item: WorkItem,
  extras?: {
    blocked: Set<string>;
    labels: Map<string, Label[]>;
    kept: Set<string>;
    recovery?: Map<string, import("../work-items/recovery.js").WorkItemRecovery>;
  },
): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    version: item.version,
    assignee: item.assignee,
    department: item.department,
    createdBy: item.createdBy,
    parentId: item.parentId,
    rootId: item.rootId,
    depth: item.depth,
    dueAt: item.dueAt,
    source: item.source,
    sourceRef: item.sourceRef,
    rank: item.rank,
    labels: extras ? extras.labels.get(item.id) ?? [] : getWorkItemLabels(item.id),
    blocked: extras ? extras.blocked.has(item.id) : isBlocked(item.id),
    kept: extras ? extras.kept.has(item.id) : isWorkItemKept(initDb(), item.id),
    sessionRef: sessionRef(item),
    attentionLane: attentionLaneOf(item, extras?.recovery?.get(item.id)),
    ...stopCause(item),
    updatedAt: item.updatedAt,
  };
}

/** One page of compact rows, with every batched projection they read taken in
 *  ONE query each across the whole page rather than per item. */
export function workItemPagePayload(page: ReturnType<typeof queryWorkItems>): Record<string, unknown> {
  const ids = page.workItems.map((item) => item.id);
  const extras = {
    blocked: blockedSet(ids),
    labels: labelSets(ids),
    kept: keptSet(initDb(), ids),
    recovery: recoveryByItem(ids),
  };
  return {
    workItems: page.workItems.map((item) => compactWorkItem(item, extras)),
    total: page.total,
    totals: page.totals,
    limit: page.limit,
    offset: page.offset,
    nextOffset: page.nextOffset,
    // Only a text query produces one, and its absence is how a caller tells a
    // filter-only page from a search that matched nothing on every row.
    ...(page.matches ? { matches: page.matches } : {}),
  };
}

/** PLA-157: why a stopped Todo stopped, flattened onto the compact row so the
 *  board can tell a clock-wait from a you-wait. Read only for the two statuses
 *  that can carry one — a page is mostly rows that never stopped — and absent
 *  entirely once the park has passed, so no surface has to re-check the clock
 *  to avoid showing a countdown that already ran out. */
function stopCause(item: WorkItem): TodoStopCause {
  if (item.status !== "blocked") return {};
  return readStopCause(initDb(), item.id) ?? {};
}

function sessionRef(item: WorkItem): Record<string, string> | null {
  if (!item.sourceRef) return null;
  const m = /^session:([^:]+)(?::(.+))?$/.exec(item.sourceRef);
  if (m) return m[2] ? { sessionId: m[1], ref: m[2] } : { sessionId: m[1] };
  const delegated = /^delegate:([^:]+)(?::(.+))?$/.exec(item.sourceRef);
  if (delegated) return delegated[2] ? { sessionId: delegated[1], ref: delegated[2] } : { sessionId: delegated[1] };
  return null;
}

export function fullWorkItemPayload(item: WorkItem): Record<string, unknown> {
  return {
    workItem: item,
    spendUsd: getWorkItemSpend(item.id),
    events: listWorkItemEvents(item.id),
    comments: commentsTail(item.id),
    relations: listRelations(item.id),
    labels: getWorkItemLabels(item.id),
    // ICI-1357 (additive): whether this Todo sits on the operator's Home board.
    kept: isWorkItemKept(initDb(), item.id),
    // ICI-728 (additive): the attempt ledger, oldest first. Status says where the
    // Todo is; runs say what each attempt at it actually did.
    runs: listWorkItemRuns(item.id),
    // ICI-733 (additive): how the NEXT attempt runs — preloaded skills and the
    // engine/model override. Null when the Todo has never had any set.
    dispatchConfig: getTodoDispatchConfig(item.id) ?? null,
  };
}

/** The board/attention enrichment contract: only the two projections those
 * surfaces read. Heavy comments, relations and labels stay
 * behind the single-item detail route. */
export function openWorkItemPayload(item: WorkItem, events = listWorkItemEvents(item.id)): Record<string, unknown> {
  return {
    workItem: item,
    events,
  };
}
