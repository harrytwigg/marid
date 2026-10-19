import { findLinks } from "../board-walk/pr-state.js";
import type { BoardHookEvent } from "../shared/board-hooks-config.js";
import { commentsTail, getComment, type WorkItemComment } from "../work-items/comments.js";
import { getWorkItemLabels } from "../work-items/labels.js";
import { getWorkItem, listWorkItems, type WorkItem, type WorkItemEvent } from "../work-items/store.js";
import { actorOf } from "./actor.js";
import type { BasePayload } from "./types.js";

/** Comments scanned for a pull-request link, newest first. */
const PR_SCAN_COMMENTS = 20;

function firstPullUrl(texts: ReadonlyArray<string | null | undefined>): string | null {
  for (const text of texts) {
    const hit = findLinks([text], 1000).find((link) => link.kind === "pull");
    if (hit) return hit.url;
  }
  return null;
}

/** The comment this event is about, when it is a live one. */
function commentOf(event: WorkItemEvent): WorkItemComment | undefined {
  const id = event.detail?.commentId;
  return event.kind === "comment_added" && typeof id === "string" ? getComment(id) : undefined;
}

/** The comment body, or the note on the event. */
function textOf(event: WorkItemEvent, comment: WorkItemComment | undefined): string | null {
  if (comment) return comment.body;
  const note = event.detail?.note;
  return typeof note === "string" && note ? note : null;
}

/** The first pull-request URL in the event's text, the latest comments (newest first), then the Todo body. */
function prUrlFor(item: WorkItem, text: string | null): string | null {
  const recent = commentsTail(item.id, PR_SCAN_COMMENTS).comments.filter((comment) => !comment.deletedAt).reverse();
  return firstPullUrl([text, ...recent.map((comment) => comment.body), item.body]);
}

function linkedSessionId(event: WorkItemEvent): string | null {
  const id = event.kind === "session_linked" ? event.detail?.sessionId : undefined;
  return typeof id === "string" ? id : null;
}

function todoOf(item: WorkItem): BasePayload["todo"] {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    department: item.department,
    labels: getWorkItemLabels(item.id).map((label) => label.name),
    assignee: item.assignee,
    parentId: item.parentId,
    rootId: item.rootId,
    childIds: listWorkItems({ parentId: item.id }).map((child) => child.id),
    url: `/todos/${item.id}`,
  };
}

/**
 * The part of a payload every hook on this event shares (docs/board-hooks.md,
 * Payload). `from` and `to` are the status move and are null on every other
 * event. Returns null when the Todo no longer exists.
 */
export function buildBasePayload(event: WorkItemEvent, name: BoardHookEvent): BasePayload | null {
  const item = getWorkItem(event.workItemId);
  if (!item) return null;
  const comment = commentOf(event);
  const text = textOf(event, comment);
  const status = name === "todo.status_changed";
  return {
    version: 1,
    event: name,
    eventId: event.id,
    at: event.createdAt,
    todo: todoOf(item),
    from: status ? event.fromStatus : null,
    to: status ? event.toStatus : null,
    actor: actorOf(event, comment),
    text,
    prUrl: prUrlFor(item, text),
    sessionId: linkedSessionId(event),
  };
}
