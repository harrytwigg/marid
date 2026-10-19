import type { WorkItemStatusWire } from "@/lib/api"
import { STATUS_LABEL } from "@/lib/todos"
import { StatusCircle } from "@/routes/todos/state-glyph"

/** The hover glance on a Todo mention: what that Todo is, on one line, with
 *  nothing to click. The card around it (`HoverCardContent`) is the glass
 *  surface, so this draws none. Everything else about it lives on the page the
 *  mention already links to, so this stays a read and never grows an action. */
export function TodoGlance({
  id,
  title,
  status,
}: {
  id: string
  title: string
  status: WorkItemStatusWire
}) {
  return (
    <span
      className="flex max-w-[380px] items-center gap-[7px] whitespace-nowrap py-[6px] pr-[11px] pl-[8px] text-[length:var(--text-caption1)] text-[var(--text-secondary)]"
    >
      <StatusCircle status={status} size={16} />
      <span className="font-[family-name:var(--font-code)]">{id}</span>
      <GlanceDot />
      <b className="min-w-0 overflow-hidden text-ellipsis font-[var(--weight-medium)] text-[var(--text-primary)]">
        {title}
      </b>
      <GlanceDot />
      <span>{STATUS_LABEL[status]}</span>
    </span>
  )
}

function GlanceDot() {
  return (
    <span
      aria-hidden
      className="size-[2.5px] flex-none rounded-full bg-[var(--text-quaternary)]"
    />
  )
}
