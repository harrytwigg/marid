import { useEffect, useRef, useState } from "react"
import { Pause } from "lucide-react"
import { AttachmentRefText } from "@/components/attachment-ref-preview"
import type { Employee, WorkItemDetailWire, WorkItemEventWire } from "@/lib/api"
import { StopCauseLead } from "../board/stop-cause"
import { displayNameOf, formatRelativeTime, stopReasonOf } from "../util"

/* Todos v2 slice 6 — the task page's banner zone (design-doc §7.2, states mock
 * §5). The banner shows a blocked Todo. Neutral --bg-secondary card, tinted
 * header word + glyph, rail-quoted reason in the author's voice — status colour
 * as accent, never a painted panel. The reason is asked for HERE, never
 * demanded by a modal: a blocked item without a note grows an inline reason
 * field (board drops focus it — review F6).
 *
 * Nothing in this banner commits without a deliberate submit. A reason is the
 * operator's word, and a blur is not a word — switching browser tabs
 * mid-sentence used to save an unfinished note. */

export type BannerKind = "blocked"

export function bannerKindOf(detail: WorkItemDetailWire): BannerKind | null {
  return detail.workItem.status === "blocked" ? "blocked" : null
}

/** The newest event that carries this exception state's reason: a transition
 *  into the status, or a same-status annotate note (both carry toStatus). */
export function exceptionReasonOf(detail: WorkItemDetailWire): { note: string | null; event: WorkItemEventWire | null } {
  return stopReasonOf(detail.events, detail.workItem.status)
}

const KIND_STYLE: Record<BannerKind, { color: string; rail: string }> = {
  blocked: { color: "var(--system-orange)", rail: "color-mix(in srgb, var(--system-orange) 38%, transparent)" },
}

const QUIET_BTN =
  "focus-ring min-h-11 rounded-full px-3 text-[12.5px] font-semibold text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)] disabled:opacity-40 sm:min-h-8"

export function TaskBanner({
  detail,
  byName,
  focusReason,
  busy,
  onCommitReason,
  actions,
}: {
  detail: WorkItemDetailWire
  byName: Map<string, Employee>
  /** Board drop hand-off (review F6): focus the reason field on arrival. */
  focusReason: boolean
  busy: boolean
  onCommitReason: (note: string) => void
  /** Kind-contextual route actions (the status/assignee pickers own them). */
  actions?: React.ReactNode
}) {
  const kind = bannerKindOf(detail)
  const { note, event } = exceptionReasonOf(detail)
  const needsReason = kind !== null && !note
  const [reason, setReason] = useState("")
  const reasonRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if ((focusReason || needsReason) && reasonRef.current) reasonRef.current.focus()
    // Focus once on arrival / when the field appears — not on every keystroke.
  }, [focusReason, needsReason])

  if (!kind) return null
  const style = KIND_STYLE[kind]
  const when = [event ? formatRelativeTime(event.createdAt) : null, event?.actor ? displayNameOf(event.actor, byName) : null]
    .filter(Boolean)
    .join(" · ")

  const commitReason = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = reason.trim()
    if (!trimmed) return
    onCommitReason(trimmed)
    setReason("")
  }

  return (
    <div
      data-testid={`task-banner-${kind}`}
      className="mb-3.5 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[14px_16px] shadow-[var(--shadow-card)]"
    >
      <div className="flex items-center gap-2.5 text-[14px] font-semibold" style={{ color: style.color }}>
        <Pause size={14} strokeWidth={2} aria-hidden />
        Blocked
        {when && <span className="ml-auto text-[11px] font-normal text-[var(--text-quaternary)]">{when}</span>}
      </div>

      {/* The card's lead, read from the detail payload: what ends the wait and
          whose move it is. It renders nothing once the park has passed. */}
      <StopCauseLead
        item={{ id: detail.workItem.id, parkedUntil: detail.parkedUntil, unblockHint: detail.unblockHint }}
        className="ml-[25px] mt-2"
      />

      {note ? (
        <div className="relative ml-[25px] mt-2 py-0.5 pl-3 text-[14px] leading-[1.5] text-[var(--text-secondary)]">
          <span
            aria-hidden
            className="absolute bottom-[3px] left-0 top-[3px] w-[2px] rounded-[1px]"
            style={{ background: style.rail }}
          />
          <AttachmentRefText text={note} />
        </div>
      ) : needsReason ? (
        // Submit-only: Enter or Save. A blur is not a decision — leaving the
        // tab must never freeze a half-written sentence onto the record.
        <form onSubmit={commitReason} className="relative ml-[25px] mt-2 flex items-center gap-2 py-0.5 pl-3">
          <span
            aria-hidden
            className="absolute bottom-[3px] left-0 top-[3px] w-[2px] rounded-[1px]"
            style={{ background: style.rail }}
          />
          <input
            ref={reasonRef}
            data-testid="task-banner-reason"
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            placeholder={"What is this waiting on?"}
            aria-label="Reason"
            className="min-w-0 flex-1 rounded-[9px] bg-[var(--fill-quaternary)] px-2.5 py-1.5 text-[14px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
          />
          <button
            type="submit"
            data-testid="task-banner-reason-save"
            disabled={busy || !reason.trim()}
            className={`${QUIET_BTN} flex-none`}
          >
            Save
          </button>
        </form>
      ) : null}

      {actions && <div className="ml-[30px] mt-3 flex items-center gap-2.5">{actions}</div>}
    </div>
  )
}
