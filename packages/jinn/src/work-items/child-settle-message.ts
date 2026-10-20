import type { JsonObject, SessionDeliveryPayload } from "../shared/types.js";
import { initDb } from "../shared/db.js";
import { getSession } from "../sessions/registry.js";
import type { ChildSettleRow } from "./child-settles.js";
import { getWorkItem, type WorkItem } from "./store.js";

/** How much of the move's note a wake carries; the child's own comments hold the rest. */
export const CHILD_SETTLE_NOTE_MAX_CHARS = 500;
const DISPLAY_TITLE_MAX_CHARS = 120;

interface SettledChild {
  row: ChildSettleRow;
  title: string;
  /** The child's status now, when it has moved on since the row was written. */
  now: string | undefined;
  mover: string;
  note: string | undefined;
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

/** The event's own record: the note of the move and, when the status route
 *  stamped one, the employee it was made for. */
function eventDetail(eventId: string): Record<string, unknown> {
  const raw = (initDb().prepare("SELECT detail FROM work_item_events WHERE id = ?").pluck().get(eventId) as string | null | undefined) ?? null;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** The employee behind a recorded move: stamped on the event by the status
 *  route, or else the employee of the session the actor names. */
export function settleMoverEmployee(row: Pick<ChildSettleRow, "actor" | "eventId">): string | undefined {
  const stamped = eventDetail(row.eventId).actorEmployee;
  if (typeof stamped === "string" && stamped) return stamped;
  if (!row.actor.startsWith("session:")) return undefined;
  return getSession(row.actor.slice("session:".length))?.employee ?? undefined;
}

function describeMover(row: ChildSettleRow): string {
  if (!row.actor.startsWith("session:")) return row.actor;
  const sessionId = row.actor.slice("session:".length);
  const employee = settleMoverEmployee(row);
  return employee ? `${employee} (session ${sessionId.slice(0, 8)})` : `session ${sessionId.slice(0, 8)}`;
}

function settledChild(row: ChildSettleRow): SettledChild {
  const child = getWorkItem(row.childId);
  const note = eventDetail(row.eventId).note;
  return {
    row,
    title: child?.title ?? row.childId,
    now: child && child.status !== row.toStatus ? child.status : undefined,
    mover: describeMover(row),
    note: typeof note === "string" && note.trim() ? clip(note, CHILD_SETTLE_NOTE_MAX_CHARS) : undefined,
  };
}

function childLine(child: SettledChild): string {
  const { row } = child;
  const moved = `${row.fromStatus} → ${row.toStatus}${child.now ? ` (now ${child.now})` : ""} by ${child.mover}`;
  return [`- ${row.childId} "${clip(child.title, DISPLAY_TITLE_MAX_CHARS)}": ${moved}`, ...(child.note ? [`  note: ${child.note}`] : [])].join("\n");
}

const ACTIONS = [
  "What to do:",
  "- Run get_work_item on each child above and read its note and comments.",
  "- A child in in_review is addressed to you as the parent's owner: accept it (move it to done with a note) or send it back (move it to executing with what must change).",
  "- Unblock or re-plan a child that is blocked.",
  "- When no child is left open (backlog or executing), carry the parent on: integrate what landed and move it forward.",
].join("\n");

/** The parent's `get_work_item_tree` is the full picture; the wake names only what changed. */
function reasonText(parent: Pick<WorkItem, "id" | "title">, children: readonly SettledChild[]): string {
  const count = children.length === 1 ? "A child Todo" : `${children.length} child Todos`;
  return `${count} of ${parent.id} ("${clip(parent.title, DISPLAY_TITLE_MAX_CHARS)}") settled:\n${children.map(childLine).join("\n")}`;
}

/** What changed, for a re-dispatch's prompt. */
export function childSettleReason(parent: Pick<WorkItem, "id" | "title">, rows: readonly ChildSettleRow[]): string {
  return reasonText(parent, rows.map(settledChild));
}

/** The wake as the engine reads it, and the line the owner's transcript shows. */
export function childSettlePayload(parent: Pick<WorkItem, "id" | "title">, rows: readonly ChildSettleRow[]): SessionDeliveryPayload {
  const children = rows.map(settledChild);
  const meta: JsonObject = {
    kind: "todo-child-settled",
    parentId: parent.id,
    children: children.map((child) => ({
      id: child.row.childId,
      from: child.row.fromStatus,
      to: child.row.toStatus,
      actor: child.row.actor,
    })),
  };
  const displayLines = children.map((child) => `${child.row.childId} ${child.row.fromStatus} → ${child.row.toStatus}: ${clip(child.title, DISPLAY_TITLE_MAX_CHARS)}`);
  return {
    message: `🌿 ${reasonText(parent, children)}\n\n${ACTIONS}`,
    displayMessage: `🌿 ${children.length === 1 ? "Child Todo settled" : `${children.length} child Todos settled`} · ${parent.id}\n${displayLines.join("\n")}`,
    meta,
  };
}
