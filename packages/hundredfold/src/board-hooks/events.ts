import type { BoardHookEvent } from "../shared/board-hooks-config.js";
import type { WorkItemEvent } from "../work-items/store.js";

function detailOf(event: WorkItemEvent): Record<string, unknown> {
  return event.detail ?? {};
}

function isAssignment(event: WorkItemEvent): boolean {
  const detail = detailOf(event);
  if (event.kind === "note") return typeof detail.assignee === "string";
  if (event.kind !== "metadata_edited") return false;
  return Array.isArray(detail.updatedFields) && detail.updatedFields.includes("assignee");
}

function linkEvent(event: WorkItemEvent): BoardHookEvent | null {
  const via = detailOf(event).via;
  if (via === "delegation") return "todo.delegated";
  return via === "dispatch" ? "todo.dispatched" : null;
}

/**
 * The board event an audit row stands for, or null when it is not one. This is
 * the Events table in docs/board-hooks.md: `session_linked` rows without a `via`
 * (older rows, other link paths) fire nothing.
 */
export function boardEventName(event: WorkItemEvent): BoardHookEvent | null {
  switch (event.kind) {
    case "created":
      return "todo.created";
    case "status_change":
    case "escalated":
      return event.toStatus !== null ? "todo.status_changed" : null;
    case "comment_added":
      return "todo.commented";
    case "session_linked":
      return linkEvent(event);
    default:
      return isAssignment(event) ? "todo.assigned" : null;
  }
}
