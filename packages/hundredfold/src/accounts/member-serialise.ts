import type { Database as DatabaseType } from "better-sqlite3";
import { compactWorkItem, workItemTreePayload, type WorkItemTreeNodePayload } from "../gateway/work-item-payload.js";
import { listAttachments, type WorkItemAttachment } from "../work-items/attachments.js";
import { commentsTail, type WorkItemComment } from "../work-items/comments.js";
import { recoveryByItem } from "../work-items/recovery-rows.js";
import { getWorkItemLabels, labelSets, type Label } from "../work-items/labels.js";
import { memberDisplayName, memberIdOf, outwardComment, isMemberIdentity } from "../work-items/member-identity.js";
import { listRelations, blockedSet } from "../work-items/relations.js";
import { reviewAddressee } from "../work-items/review-addressee.js";
import { getWorkItemSprint, sprintRefs } from "../work-items/sprints.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { getSession } from "../sessions/registry.js";
import { listWorkItemEvents, type WorkItem, type WorkItemEvent, type queryWorkItems } from "../work-items/store.js";
import { readStopCause } from "../work-items/stop-cause.js";
import { initDb } from "../shared/db.js";
import { TODO_ID_PATTERN } from "../work-items/id.js";
import { OPERATOR_ASSIGNEE } from "../work-items/operator-assignee.js";
import { boardOfTodo, creatorAccess, isClosedStatus } from "./member-access.js";
import type { MemberRouteContext } from "./member-context.js";
import { getGrant } from "./board-members.js";

/**
 * Everything a board member reads, in the shapes the operator's routes use, minus what references a
 * session, a run, a transcript, money or the operator's own desk. These are allowlists of fields to
 * drop, applied in one place so no member route serialises a Todo, comment, event or attachment itself.
 */

/** Whether a name is an employee on the roster, as this instance is configured. */
function isEmployee(name: string): boolean {
  return orgRegistry().has(name);
}

/**
 * Who is reading: a member, and the people they may be shown. A `user:<id>` reads as itself only when that person is the
 * reader or is an active user who currently holds one of the reader's boards. Remembered per reader, so a page asks the
 * database once per person.
 */
export class Viewer {
  private readonly known = new Map<string, boolean>();
  private readonly held = new Map<string, boolean>();
  private readonly boards = new Map<string, boolean>();
  private readonly creatorRoots = new Map<string, { canComment: boolean } | null>();
  constructor(readonly db: DatabaseType, readonly userId: string) {}

  /** Whether a department is one of the reader's boards. */
  holdsBoard(department: string): boolean {
    let answer = this.boards.get(department);
    if (answer === undefined) {
      answer = !!getGrant(this.db, this.userId, department);
      this.boards.set(department, answer);
    }
    return answer;
  }

  /** What the reader's creator access to a root is (see `creatorAccess`), or null when it gives them none. Asked once per root. */
  creatorAccessOf(rootId: string): { canComment: boolean } | null {
    let answer = this.creatorRoots.get(rootId);
    if (answer === undefined) {
      const access = creatorAccess(this.db, this.userId, rootId);
      answer = access ? { canComment: access.canComment } : null;
      this.creatorRoots.set(rootId, answer);
    }
    return answer;
  }

  /** Whether the reader had creator access to a root as it stood before a reparent took `itemId` out from under it (`itemId` itself when it was the root). */
  hadCreatorAccess(oldRootId: string, itemId: string): boolean {
    return creatorAccess(this.db, this.userId, oldRootId, { asRoot: oldRootId === itemId }) !== undefined;
  }

  /**
   * Whether the status write being announced is the one that ended the reader's creator access to this Todo: the Todo is a
   * root, the write's own move took it from open to done or cancelled, and immediately before it they read it as its creator
   * (active, it is theirs, and they still hold the board it was filed on, none of which a status write changes). Read from
   * the move the write carries, never from the Todo's latest event, so a close of a Todo they had already lost (taken off the
   * board, moved under another tree, a sub-task moved out) is silent.
   */
  closedAsCreatorRoot(item: Pick<WorkItem, "id" | "rootId">, move: { fromStatus: string; toStatus: string } | undefined): boolean {
    if (!move || !isClosedStatus(move.toStatus) || isClosedStatus(move.fromStatus)) return false;
    return creatorAccess(this.db, this.userId, item.id, { openBeforeWrite: true }) !== undefined;
  }

  /** Whether a root is open and was created by the reader on a board they still hold, so its tree stays readable to them after it leaves that board. */
  readsAsCreator(rootId: string): boolean {
    return this.creatorAccessOf(rootId) !== null;
  }

  /** Whether a Todo (by id) is one the reader may read: on a board they hold, or in an open tree whose root they created; a Todo that is gone is not. */
  holdsTodo(todoId: string): boolean {
    let answer = this.held.get(todoId);
    if (answer === undefined) {
      const row = initDb().prepare("SELECT id, root_id, department FROM work_items WHERE id = ?").get(todoId) as
        { id: string; root_id: string; department: string | null } | undefined;
      const board = row ? boardOfTodo({ id: row.id, rootId: row.root_id, department: row.department }) : null;
      answer = !!row && ((!!board && this.holdsBoard(board)) || this.readsAsCreator(row.root_id));
      this.held.set(todoId, answer);
    }
    return answer;
  }

  /** Whether a Todo has left the reader's boards: it is on another board, or on the company board, and they read it as its creator. */
  movedOff(item: Pick<WorkItem, "id" | "rootId" | "department">): boolean {
    const board = boardOfTodo(item);
    return board === null || !this.holdsBoard(board);
  }

  knows(otherId: string): boolean {
    if (otherId === this.userId) return true;
    let answer = this.known.get(otherId);
    if (answer === undefined) {
      answer = this.db.prepare(
        `SELECT 1 FROM board_members a JOIN board_members b ON a.department = b.department JOIN users u ON u.id = b.user_id
         WHERE a.user_id = ? AND b.user_id = ? AND u.status = 'active' LIMIT 1`,
      ).get(this.userId, otherId) !== undefined;
      this.known.set(otherId, answer);
    }
    return answer;
  }
}

/** The reader a member route serves. */
export const viewerOf = (ctx: MemberRouteContext): Viewer => new Viewer(ctx.deps.accounts.getDb(), ctx.principal.userId);

/** The generic actors: `member` stands for a person the reader may not be told about (the web shows "Former member"). */
const ALLOWED_ACTORS: ReadonlySet<string> = new Set(["operator", "agent", "system", "member"]);

/** The roster employee a `session:<id>` actor was working as, when there is one. */
function sessionEmployee(identity: string): string | undefined {
  const employee = getSession(identity.slice("session:".length))?.employee;
  return employee && isEmployee(employee) ? employee : undefined;
}

/**
 * The ONE place the actors a member may see are decided, for REST reads and live frames alike. An actor
 * (creator, author, uploader, event actor) is built from an allowed set and nothing else: an employee on the roster,
 * `operator`, a `user:<id>` on the reader's boards (or the reader), or a generic `agent` / `system` / `member`. Any other
 * person reads as "member". A session reads as its employee when it has one, else "agent". Anything else (a plugin, a
 * cron job, a workflow, the gateway's own machinery, a name no longer on the roster) becomes "system" or "agent", with
 * no identifier. Known-bad values are not filtered: only what is allowed passes.
 */
export function memberWho(identity: string, viewer: Viewer): string {
  const person = memberIdOf(identity);
  if (person !== undefined) return viewer.knows(person) ? identity : "member";
  if (ALLOWED_ACTORS.has(identity)) return identity;
  if (identity.startsWith("session:")) return sessionEmployee(identity) ?? "agent";
  if (isEmployee(identity)) return identity;
  return identity.includes(":") ? "system" : "agent";
}

/**
 * A Todo's own department as a member reads it: a department that is not one of the reader's boards is never named, so a
 * sub-task that sits in another department reads as having none of its own (it is on its root's board, which is theirs).
 */
function memberDepartment(department: string | null, viewer: Viewer): string | null {
  return department !== null && !viewer.holdsBoard(department) ? null : department;
}

/** Labels as a member reads them: a label scoped to a department that is not one of their boards reads as unscoped. */
function memberLabels(labels: Label[], viewer: Viewer): Label[] {
  return labels.map((label) => ({ ...label, department: memberDepartment(label.department, viewer) }));
}

/** The person responsible as a member reads them: the operator stays, a user on the reader's boards (or the reader) stays, any other person is the generic `member`. */
export function memberHuman(person: string | null, viewer: Viewer): string | null {
  if (person === null || person === OPERATOR_ASSIGNEE) return person;
  return memberIdOf(person) !== undefined ? memberWho(person, viewer) : null;
}

/** A Todo as a member reads it: the operator's row without the session-bearing `sourceRef`, budget, session creator or another board's name. */
export function memberWorkItem(item: WorkItem, viewer: Viewer): WorkItem {
  return {
    ...item, sourceRef: null, budgetUsd: null, createdBy: memberWho(item.createdBy, viewer), department: memberDepartment(item.department, viewer),
    humanAssignee: memberHuman(item.humanAssignee, viewer),
    ...movedMarker(item, viewer),
  };
}

/**
 * `movedToAnotherBoard: true` on a Todo the reader reads only as its creator, after it left the board they filed it on, with
 * `memberCanComment` saying whether their role there lets them comment. The destination is never named: the Todo's own
 * department reads `null`, and nothing here says where it went.
 */
function movedMarker(item: Pick<WorkItem, "id" | "rootId" | "department">, viewer: Viewer): { movedToAnotherBoard?: true; memberCanComment?: boolean } {
  if (!viewer.movedOff(item)) return {};
  const access = viewer.creatorAccessOf(item.rootId);
  return access ? { movedToAnotherBoard: true, memberCanComment: access.canComment } : {};
}

type CompactExtras = Parameters<typeof compactWorkItem>[1];

/** One compact board row for a member. */
function memberCompact(item: WorkItem, extras: CompactExtras, viewer: Viewer): Record<string, unknown> {
  // `sessionRef` is a session field: removed, not nulled.
  const { sessionRef: _sessionRef, ...row } = compactWorkItem(item, extras);
  return {
    ...row,
    labels: memberLabels(row.labels as Label[], viewer),
    createdBy: memberWho(item.createdBy, viewer),
    humanAssignee: memberHuman(item.humanAssignee, viewer),
    department: memberDepartment(item.department, viewer),
    sourceRef: null,
    kept: false,
    attentionLane: null,
    ...movedMarker(item, viewer),
  };
}

/** One page of compact rows, with every batched projection read in one query each, as the operator's list does. */
export function memberPagePayload(page: ReturnType<typeof queryWorkItems>, viewer: Viewer): Record<string, unknown> {
  const ids = page.workItems.map((item) => item.id);
  const extras: NonNullable<CompactExtras> = {
    blocked: blockedSet(ids),
    labels: labelSets(ids),
    sprints: sprintRefs(ids),
    kept: new Set<string>(),
    // One query for the page, as the operator's list reads it, rather than one per row (the lane itself is not shown to members).
    recovery: recoveryByItem(ids),
  };
  const workItems = page.workItems.map((item) => memberCompact(item, extras, viewer));
  // As the operator's list does: the names of the people the rows name, so a reader can say who they are.
  const members = membersNamed(workItems.map((row) => row.humanAssignee as string | null));
  return {
    workItems,
    ...(Object.keys(members).length > 0 ? { members } : {}),
    total: page.total,
    totals: page.totals,
    limit: page.limit,
    offset: page.offset,
    nextOffset: page.nextOffset,
    ...(page.matches ? { matches: page.matches } : {}),
  };
}

function memberTreeNode(node: WorkItemTreeNodePayload, viewer: Viewer): WorkItemTreeNodePayload {
  return { ...node, ...memberWorkItem(node, viewer), children: node.children.map((child) => memberTreeNode(child, viewer)) };
}

/** A subtree for a member. Spend is money the operator spent on sessions: a member reads null. */
export function memberTreePayload(payload: ReturnType<typeof workItemTreePayload>, viewer: Viewer): ReturnType<typeof workItemTreePayload> {
  return { ...payload, spendUsd: null as unknown as number, root: memberTreeNode(payload.root, viewer) };
}

/** A comment as a member reads it: the member kind derived from the stored author (before it is mapped), and no session behind it. */
export function memberComment(comment: WorkItemComment, viewer: Viewer): ReturnType<typeof outwardComment<WorkItemComment>> {
  const { sessionId: _sessionId, ...rest } = comment;
  return { ...outwardComment(rest as WorkItemComment), author: memberWho(comment.author, viewer) };
}

export function memberCommentPage(page: { comments: WorkItemComment[]; total: number }, viewer: Viewer): { comments: Array<ReturnType<typeof memberComment>>; total: number } {
  return { ...page, comments: page.comments.map((comment) => memberComment(comment, viewer)) };
}

/** Event kinds that are the operator's own machinery: a member's timeline does not show them. */
const INTERNAL_EVENT_KINDS: ReadonlySet<string> = new Set([
  "session_linked", "approval_requested", "approval_decided", "verify_result", "claim_rejected", "claim_expired",
  "respawn_guard_held", "availability_resumed", "kept_changed", "recovery_classified", "recovery_attempted",
  "recovery_exhausted", "anomaly_observed", "quiet_nudged", "quiet_escalated",
]);

/** Detail keys that name a session, a run or the surface a write came from. */
const SESSION_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "runId", "runIds", "deliveryId", "sourceRef", "origin", "todoProvenance",
]);

/** Any key that names a session, at any depth (sessionId, childSessionId, releasedSessions, callerSessionId...). */
const SESSION_KEY = /session/i;

/** A key a member's event detail never carries, wherever it sits. */
function isSessionKey(key: string): boolean {
  return SESSION_DETAIL_KEYS.has(key) || SESSION_KEY.test(key);
}

/** A bare session id, or an internal identity a member never reads (a session, plugin, cron job or workflow). */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERNAL_IDENTITY = /^(session|plugin|cron|workflow):/;

function memberEventActor(event: WorkItemEvent, createdBy: string, viewer: Viewer): string | null {
  // A created event records the write's source (connector, human, cron...) as its actor: the creator is the Todo's `created_by`.
  if (event.kind === "created") return memberWho(createdBy, viewer);
  if (!event.actor) return null;
  const employee = event.detail?.actorEmployee;
  if (event.actor.startsWith("session:") && typeof employee === "string" && isEmployee(employee)) return employee;
  return memberWho(event.actor, viewer);
}

const DROPPED = Symbol("dropped");

/** One string in an event detail: a department under a department key, or a Todo id anywhere, the reader may not be told of is dropped. */
function memberDetailString(value: string, viewer: Viewer, key: string | undefined): string | typeof DROPPED {
  if (key !== undefined && DEPARTMENT_KEY.test(key)) return viewer.holdsBoard(value) ? value : DROPPED;
  if (SESSION_UUID.test(value) || INTERNAL_IDENTITY.test(value)) return DROPPED;
  if (isMemberIdentity(value)) return memberWho(value, viewer);
  return TODO_ID_PATTERN.test(value) && !viewer.holdsTodo(value) ? DROPPED : value;
}

/** Event detail keys whose value is a department: `department`, `movedTo`, and any `...Department`. */
const DEPARTMENT_KEY = /^(department|movedTo)$|Department$/;

/**
 * An event detail value with everything the reader may not be told taken out, at any depth, judged by value as well as
 * by key: a session key goes wherever it sits; a bare session id, or a session, plugin, cron or workflow identity, goes
 * whatever key carries it; a person reads as the actor rule says; a Todo id is kept only when that Todo is on a board the
 * reader holds (the rule relations follow); a department under a department key only when it is one of the reader's
 * boards. An array loses such entries and an object such keys.
 */
function memberDetailValue(value: unknown, viewer: Viewer, key?: string): unknown {
  if (typeof value === "string") return memberDetailString(value, viewer, key);
  if (Array.isArray(value)) return value.map((entry) => memberDetailValue(entry, viewer, key)).filter((entry) => entry !== DROPPED);
  if (!value || typeof value !== "object") return value;
  const kept: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (isSessionKey(name)) continue;
    const scrubbed = memberDetailValue(entry, viewer, name);
    if (scrubbed !== DROPPED) kept[name] = scrubbed;
  }
  return kept;
}

/**
 * The detail keys a member's timeline carries, per event kind: what the member web renders, and nothing else. Every other
 * key, and every key of a kind not listed, is dropped, whatever it holds. What is kept is then judged by value as well
 * (a Todo id the member cannot read, another board's name, a session or internal identity are dropped; a person reads
 * as the actor rule says), so an allowed key carrying something unexpected still leaks nothing.
 */
const MEMBER_DETAIL_KEYS: Readonly<Record<string, readonly string[]>> = {
  child_created: ["childId"],
  comment_added: ["commentId"],
  comment_edited: ["commentId"],
  comment_deleted: ["commentId"],
  relation_added: ["srcId", "dstId", "kind"],
  relation_removed: ["srcId", "dstId", "kind"],
  label_changed: ["labels"],
  sprint_changed: ["sprint", "from", "reason"],
  attachment_added: ["attachmentId", "filename", "commentId", "supersedes"],
  attachment_removed: ["attachmentId", "filename"],
  metadata_edited: ["updatedFields"],
  status_change: ["bounce", "rounds", "note", "reason"],
  escalated: ["reason", "note"],
  note: ["assignee", "note", "updatedFields", "department"],
  person_changed: ["from", "to", "assigneeCleared", "reason", "withAgent"],
};

/** An assignee named on a member's timeline: the operator's reserved value, or an employee through the actor rule. */
function memberAssignee(value: unknown, viewer: Viewer): unknown {
  return value === OPERATOR_ASSIGNEE || typeof value !== "string" ? value : memberWho(value, viewer);
}

function memberEventDetail(event: WorkItemEvent, viewer: Viewer): WorkItemEvent["detail"] {
  if (!event.detail) return event.detail;
  const picked: Record<string, unknown> = {};
  for (const key of MEMBER_DETAIL_KEYS[event.kind] ?? []) {
    if (key in event.detail) picked[key] = key === "assignee" ? memberAssignee(event.detail[key], viewer) : event.detail[key];
  }
  return memberDetailValue(picked, viewer) as WorkItemEvent["detail"];
}

/** An event as a member reads it, built field by field: nothing the operator's row carries passes unless it is named here. */
function memberEvent(event: WorkItemEvent, createdBy: string, viewer: Viewer): WorkItemEvent {
  return {
    id: event.id, workItemId: event.workItemId, kind: event.kind, fromStatus: event.fromStatus, toStatus: event.toStatus,
    actor: memberEventActor(event, createdBy, viewer), detail: memberEventDetail(event, viewer), createdAt: event.createdAt,
  };
}

export function memberEvents(events: WorkItemEvent[], createdBy: string, viewer: Viewer): WorkItemEvent[] {
  return events.filter((event) => !INTERNAL_EVENT_KINDS.has(event.kind)).map((event) => memberEvent(event, createdBy, viewer));
}

/** An attachment as a member reads it: where it sits on the gateway's disk is not theirs to know. */
export function memberAttachment(attachment: WorkItemAttachment, viewer: Viewer): Omit<WorkItemAttachment, "storagePath"> {
  const { storagePath: _storagePath, ...rest } = attachment;
  return { ...rest, uploadedBy: memberWho(attachment.uploadedBy, viewer) };
}

/** Relations to Todos on a board the member also holds: a relation must not tell them the title of a Todo they cannot open. */
function visibleRelations(viewer: Viewer, item: WorkItem): ReturnType<typeof listRelations> {
  return listRelations(item.id)
    .filter((relation) => viewer.holdsTodo(relation.other.id))
    .map((relation) => ({ ...relation, createdBy: memberWho(relation.createdBy, viewer) }));
}

function membersNamed(identities: ReadonlyArray<string | null | undefined>): Record<string, { kind: "member"; displayName: string }> {
  const named: Record<string, { kind: "member"; displayName: string }> = {};
  for (const identity of identities) {
    if (isMemberIdentity(identity) && !named[identity]) named[identity] = { kind: "member", displayName: memberDisplayName(identity) };
  }
  return named;
}

/** `GET /api/member/todos/:id`: the operator's detail shape (comments and events included) minus the session fields. */
export function memberDetailPayload(viewer: Viewer, item: WorkItem): Record<string, unknown> {
  const events = memberEvents(listWorkItemEvents(item.id), item.createdBy, viewer);
  const comments = memberCommentPage(commentsTail(item.id), viewer);
  const workItem = memberWorkItem(item, viewer);
  const members = membersNamed([workItem.createdBy, workItem.humanAssignee, ...events.map((event) => event.actor), ...comments.comments.map((comment) => comment.author)]);
  const stop = item.status === "blocked" ? readStopCause(initDb(), item.id) ?? {} : {};
  return {
    workItem,
    spendUsd: null,
    events,
    comments,
    ...(Object.keys(members).length > 0 ? { members } : {}),
    relations: visibleRelations(viewer, item),
    labels: memberLabels(getWorkItemLabels(item.id), viewer),
    sprint: getWorkItemSprint(item.id),
    kept: false,
    attentionLane: null,
    reviewAddressee: reviewAddressee(item),
    ...stop,
  };
}

export function memberAttachments(workItemId: string, includeSuperseded: boolean, viewer: Viewer): Array<Omit<WorkItemAttachment, "storagePath">> {
  return listAttachments(workItemId, { includeSuperseded }).map((attachment) => memberAttachment(attachment, viewer));
}
