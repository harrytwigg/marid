import { ChevronRight, CornerDownRight, Flag, Link2, Paperclip, Pencil, Plus, RotateCw, Tags } from "lucide-react"
import type { Employee, WorkItemEventWire } from "@/lib/api"
import { STATUS_LABEL } from "@/lib/todos"
import { displayNameOf, formatRelativeTime, OPERATOR_ASSIGNEE } from "../util"
import { SessionActor } from "./session-ref"

/* One audit event read back as a sentence: who did it, and what it was. The
 * feed that orders these lines lives in activity.tsx. */

interface Whisper {
  Icon: typeof Pencil
  text: string
  tinted?: boolean
}

/** A kind's sentence: fixed when it never varies, a reader of the event's
 *  detail when it does. A table rather than a switch keeps every kind to one
 *  readable mapping instead of one branch. */
type WhisperRule = Whisper | ((detail: Record<string, unknown>, event: WorkItemEventWire) => Whisper)

/** History keeps the two retired statuses: events written before the boot
 *  migration moved `assigned` and `escalated` Todos still name them. */
const RETIRED_STATUS_LABEL: Record<string, string> = { assigned: "Assigned", escalated: "Escalated" }
const statusLabel = (status: string): string => STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? RETIRED_STATUS_LABEL[status] ?? status

const WHISPERS: Record<string, WhisperRule> = {
  created: { Icon: Plus, text: "created this todo" },
  child_created: (detail) => ({
    Icon: Plus,
    text: `added a sub-task${typeof detail.childId === "string" ? ` ${detail.childId}` : ""}`,
  }),
  status_change: (detail, event) => {
    if (detail.bounce === true) {
      return { Icon: CornerDownRight, text: `sent it back · round ${typeof detail.rounds === "number" ? detail.rounds : "?"}` }
    }
    return { Icon: ChevronRight, text: `moved it to ${event.toStatus ? statusLabel(event.toStatus) : "?"}` }
  },
  // `max-rounds-exhausted` is retired with the round ceiling; older events still carry it.
  escalated: (detail) => ({
    Icon: CornerDownRight,
    text: detail.reason === "max-rounds-exhausted" ? "escalated it — review rounds exhausted" : "escalated it",
    tinted: true,
  }),
  // Naming the guard is the point: an unnamed hold reads as silence, and the
  // operator re-arms blind until they give up. Kept short so the name itself
  // survives the line's truncation at 390px.
  respawn_guard_held: (detail) => ({
    Icon: CornerDownRight,
    text: `held the dispatch${typeof detail.guard === "string" ? ` — ${detail.guard}` : ""}`,
    tinted: true,
  }),
  // The counterpart to the hold above: the window that ended the wait, and the
  // answer that decided when. The window leads instead of a verb because
  // "resumed" behind an actor reads as somebody having stepped in, which is the
  // one thing that did not happen — and because this line clips at 390px, where
  // a lead-in would push the source past the ellipsis. The comma is load-bearing
  // for the same reason: " · " measured 297px into a 295px box.
  availability_resumed: (detail) => ({
    Icon: RotateCw,
    text: `${typeof detail.engine === "string" ? `${detail.engine} ` : ""}window reopened${
      typeof detail.source === "string" ? `, ${detail.source}` : ""}`,
  }),
  note: (detail) => {
    if (detail.assignee === OPERATOR_ASSIGNEE) return { Icon: Pencil, text: "assigned it to the operator" }
    if (typeof detail.assignee === "string") return { Icon: Pencil, text: `assigned ${detail.assignee}` }
    return { Icon: Pencil, text: "added a note" }
  },
  metadata_edited: { Icon: Pencil, text: "edited the details" },
  attachment_added: (detail) => ({
    Icon: Paperclip,
    text: `attached ${typeof detail.filename === "string" ? detail.filename : "a file"}`,
  }),
  attachment_removed: { Icon: Paperclip, text: "removed an attachment" },
  label_changed: { Icon: Tags, text: "changed the labels" },
  sprint_changed: (detail) => {
    const to = typeof detail.sprint === "string" ? detail.sprint : null
    const from = typeof detail.from === "string" ? detail.from : null
    if (detail.reason === "carried" && to) return { Icon: Flag, text: `carried it over to ${to}` }
    if (to) return { Icon: Flag, text: `moved it to ${to}` }
    return { Icon: Flag, text: from ? `took it out of ${from}` : "took it out of its sprint" }
  },
  relation_added: { Icon: Link2, text: "linked a related todo" },
  relation_removed: { Icon: Link2, text: "removed a relation" },
  session_linked: { Icon: Link2, text: "linked a session" },
}

export function whisperOf(event: WorkItemEventWire): Whisper {
  const rule = WHISPERS[event.kind]
  if (rule === undefined) return { Icon: Pencil, text: event.kind.replace(/_/g, " ") }
  return typeof rule === "function" ? rule(event.detail ?? {}, event) : rule
}

function actorLabel(actor: string | null, byName: Map<string, Employee>): string {
  if (!actor || actor === "system") return "The gateway"
  if (actor === "operator") return "You"
  return displayNameOf(actor, byName)
}



export function WhisperLine({ event, byName }: { event: WorkItemEventWire; byName: Map<string, Employee> }) {
  const whisper = whisperOf(event)
  return (
    <div className="flex items-center gap-2 py-[7px] text-[12.5px] text-[var(--text-tertiary)]" data-testid={`whisper-${event.id}`}>
      <span className="mr-1.5 grid w-4 flex-none place-items-center text-[var(--text-quaternary)]">
        <whisper.Icon size={12} strokeWidth={2} aria-hidden />
      </span>
      <span className="min-w-0 truncate">
        <span className={`font-semibold ${whisper.tinted ? "text-[var(--system-red)]" : "text-[var(--text-secondary)]"}`}>
          <SessionActor actor={event.actor} byName={byName}>{actorLabel(event.actor, byName)}</SessionActor>
        </span>{" "}
        {whisper.text}
      </span>
      <span className="flex-none text-[var(--text-quaternary)]">· {formatRelativeTime(event.createdAt)}</span>
    </div>
  )
}
