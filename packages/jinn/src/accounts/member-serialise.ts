import type { Database as DatabaseType } from "better-sqlite3";
import { compactWorkItem, workItemTreePayload, type WorkItemTreeNodePayload } from "../gateway/work-item-payload.js";
import { listAttachments, type WorkItemAttachment } from "../work-items/attachments.js";
import { commentsTail, type WorkItemComment } from "../work-items/comments.js";
import { recoveryByItem } from "../work-items/recovery-rows.js";
import { getWorkItemLabels, labelSets } from "../work-items/labels.js";
import { memberDisplayName, memberIdOf, outwardComment, isMemberIdentity } from "../work-items/member-identity.js";
import { listRelations, blockedSet } from "../work-items/relations.js";
import { reviewAddressee } from "../work-items/review-addressee.js";
import { getWorkItemSprint, sprintRefs } from "../work-items/sprints.js";
import { getSession } from "../sessions/registry.js";
import { listWorkItemEvents, type WorkItem, type WorkItemEvent, type queryWorkItems } from "../work-items/store.js";
import { readStopCause } from "../work-items/stop-cause.js";
import { initDb } from "../shared/db.js";
import { boardOfTodo } from "./member-access.js";
import { getGrant } from "./board-members.js";

/**
 * Everything a board member reads, in the shapes the operator's routes use, minus what references a
 * session, a run, a transcript, money or the operator's own desk. These are allowlists of fields to
 * drop, applied in one place so no member route serialises a Todo, comment, event or attachment itself.
 */

/** Actors that are the gateway's own machinery rather than a person or an employee. */
const INTERNAL_ACTORS: ReadonlySet<string> = new Set(["reconciler", "park-expiry", "board-walk", "jinn", "system"]);

/**
 * An actor (creator, author, uploader, event actor) as a member reads it: only ever an employee name, `operator`, a
 * `user:<id>`, or a generic `agent` / `system` with no identifier. A session reads as its employee, or "agent"; a plugin,
 * a cron job, a workflow or the gateway's own machinery reads as "system". No internal id is sent to a member.
 */
export function memberWho(identity: string): string {
  if (identity === "operator" || memberIdOf(identity) !== undefined) return identity;
  if (identity.startsWith("session:")) return getSession(identity.slice("session:".length))?.employee || "agent";
  return identity.includes(":") || INTERNAL_ACTORS.has(identity) ? "system" : identity;
}

/** A Todo as a member reads it: the operator's row without the session-bearing `sourceRef`, budget or session creator. */
export function memberWorkItem(item: WorkItem): WorkItem {
  return { ...item, sourceRef: null, budgetUsd: null, createdBy: memberWho(item.createdBy) };
}

type CompactExtras = Parameters<typeof compactWorkItem>[1];

/** One compact board row for a member. */
function memberCompact(item: WorkItem, extras: CompactExtras): Record<string, unknown> {
  return {
    ...compactWorkItem(item, extras),
    createdBy: memberWho(item.createdBy),
    sourceRef: null,
    sessionRef: null,
    kept: false,
    attentionLane: null,
  };
}

/** One page of compact rows, with every batched projection read in one query each, as the operator's list does. */
export function memberPagePayload(page: ReturnType<typeof queryWorkItems>): Record<string, unknown> {
  const ids = page.workItems.map((item) => item.id);
  const extras: NonNullable<CompactExtras> = {
    blocked: blockedSet(ids),
    labels: labelSets(ids),
    sprints: sprintRefs(ids),
    kept: new Set<string>(),
    // One query for the page, as the operator's list reads it, rather than one per row (the lane itself is not shown to members).
    recovery: recoveryByItem(ids),
  };
  return {
    workItems: page.workItems.map((item) => memberCompact(item, extras)),
    total: page.total,
    totals: page.totals,
    limit: page.limit,
    offset: page.offset,
    nextOffset: page.nextOffset,
    ...(page.matches ? { matches: page.matches } : {}),
  };
}

function memberTreeNode(node: WorkItemTreeNodePayload): WorkItemTreeNodePayload {
  return { ...node, ...memberWorkItem(node), children: node.children.map(memberTreeNode) };
}

/** A subtree for a member. Spend is money the operator spent on sessions: a member reads null. */
export function memberTreePayload(payload: ReturnType<typeof workItemTreePayload>): ReturnType<typeof workItemTreePayload> {
  return { ...payload, spendUsd: null as unknown as number, root: memberTreeNode(payload.root) };
}

/** A comment as a member reads it: the member kind derived, and no session behind it. */
export function memberComment(comment: WorkItemComment): ReturnType<typeof outwardComment<WorkItemComment>> {
  const { sessionId: _sessionId, ...rest } = comment;
  return outwardComment({ ...rest, author: memberWho(comment.author) } as WorkItemComment);
}

export function memberCommentPage(page: { comments: WorkItemComment[]; total: number }): { comments: Array<ReturnType<typeof memberComment>>; total: number } {
  return { ...page, comments: page.comments.map(memberComment) };
}

/** Event kinds that are the operator's own machinery: a member's timeline does not show them. */
const INTERNAL_EVENT_KINDS: ReadonlySet<string> = new Set([
  "session_linked", "approval_requested", "approval_decided", "verify_result", "claim_rejected", "claim_expired",
  "respawn_guard_held", "availability_resumed", "kept_changed", "recovery_classified", "recovery_attempted",
  "recovery_exhausted", "anomaly_observed", "quiet_nudged", "quiet_escalated",
]);

/** Detail keys that name a session, a run or the surface a write came from. */
const SESSION_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "sessionId", "sessionIds", "session", "sessions", "releasedSessions", "parentSessionId", "runId", "deliveryId",
  "sourceRef", "origin", "todoProvenance", "callerSessionId",
]);

function memberEventActor(event: WorkItemEvent): string | null {
  if (!event.actor) return null;
  if (!event.actor.startsWith("session:")) return memberWho(event.actor);
  const employee = event.detail?.actorEmployee;
  return typeof employee === "string" && employee ? employee : memberWho(event.actor);
}

function memberEvent(event: WorkItemEvent): WorkItemEvent {
  const detail = event.detail
    ? Object.fromEntries(Object.entries(event.detail).filter(([key]) => !SESSION_DETAIL_KEYS.has(key)))
    : event.detail;
  return { ...event, actor: memberEventActor(event), detail };
}

export function memberEvents(events: WorkItemEvent[]): WorkItemEvent[] {
  return events.filter((event) => !INTERNAL_EVENT_KINDS.has(event.kind)).map(memberEvent);
}

/** An attachment as a member reads it: where it sits on the gateway's disk is not theirs to know. */
export function memberAttachment(attachment: WorkItemAttachment): Omit<WorkItemAttachment, "storagePath"> {
  const { storagePath: _storagePath, ...rest } = attachment;
  return { ...rest, uploadedBy: memberWho(attachment.uploadedBy) };
}

/** Relations to Todos on a board the member also holds: a relation must not tell them the title of a Todo they cannot open. */
function visibleRelations(db: DatabaseType, userId: string, item: WorkItem): ReturnType<typeof listRelations> {
  const find = initDb().prepare("SELECT id, root_id, department FROM work_items WHERE id = ?");
  return listRelations(item.id)
    .filter((relation) => {
      const row = find.get(relation.other.id) as { id: string; root_id: string; department: string | null } | undefined;
      const board = row ? boardOfTodo({ id: row.id, rootId: row.root_id, department: row.department }) : null;
      return !!board && !!getGrant(db, userId, board);
    })
    .map((relation) => ({ ...relation, createdBy: memberWho(relation.createdBy) }));
}

function membersNamed(identities: ReadonlyArray<string | null | undefined>): Record<string, { kind: "member"; displayName: string }> {
  const named: Record<string, { kind: "member"; displayName: string }> = {};
  for (const identity of identities) {
    if (isMemberIdentity(identity) && !named[identity]) named[identity] = { kind: "member", displayName: memberDisplayName(identity) };
  }
  return named;
}

/** `GET /api/member/todos/:id`: the operator's detail shape (comments and events included) minus the session fields. */
export function memberDetailPayload(db: DatabaseType, userId: string, item: WorkItem): Record<string, unknown> {
  const events = memberEvents(listWorkItemEvents(item.id));
  const comments = memberCommentPage(commentsTail(item.id));
  const members = membersNamed([item.createdBy, ...events.map((event) => event.actor), ...comments.comments.map((comment) => comment.author)]);
  const stop = item.status === "blocked" ? readStopCause(initDb(), item.id) ?? {} : {};
  return {
    workItem: memberWorkItem(item),
    spendUsd: null,
    events,
    comments,
    ...(Object.keys(members).length > 0 ? { members } : {}),
    relations: visibleRelations(db, userId, item),
    labels: getWorkItemLabels(item.id),
    sprint: getWorkItemSprint(item.id),
    kept: false,
    attentionLane: null,
    reviewAddressee: reviewAddressee(item),
    ...stop,
  };
}

export function memberAttachments(workItemId: string, includeSuperseded: boolean): Array<Omit<WorkItemAttachment, "storagePath">> {
  return listAttachments(workItemId, { includeSuperseded }).map(memberAttachment);
}
