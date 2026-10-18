import { ArrowRightLeft } from "lucide-react"
import type { WorkItemCompactWire, WorkItemStatusWire } from "@/lib/api"
import { STATUS_LABEL } from "@/lib/todos"
import { legalTargets } from "@/lib/legal-targets"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { StatusCircle } from "../state-glyph"
import { CLOSED_STATUSES, OPEN_COLUMN_ORDER } from "./status-scope"

/** The columns left to right, as the board shows them. */
const COLUMN_ORDER = [...OPEN_COLUMN_ORDER, ...CLOSED_STATUSES]

/* "Move to…" on a card, the phone's way to change a card's column (the desktop
 * drags). The menu lists the current column, marked, and every column the card
 * can legally go to: the same legalTargets() map the drag, the pickers and the
 * Needs-you menu read. A gated move shows with its reason and cannot be chosen,
 * and a Done that would also close open sub-tasks is one of those, as it is for
 * a drag: closing a tree is decided on the task page. */

export interface MoveToMenuProps {
  item: WorkItemCompactWire
  /** Sub-tasks not yet done or cancelled (the close gate's pre-check). */
  openChildren: number
  onMove: (item: WorkItemCompactWire, to: WorkItemStatusWire) => void
}

/** The menu's rows: the current column, then each column the card can go to. */
function moveRows(item: WorkItemCompactWire, openChildren: number) {
  const targets = legalTargets(item.status, { openChildren })
  return COLUMN_ORDER.flatMap((status) => {
    if (status === item.status) return [{ status, disabled: false, reason: undefined }]
    const target = targets.find((t) => t.status === status)
    if (!target) return []
    // A close that would also close open sub-tasks is decided on the task page, so the row says that
    // rather than what the move would have done.
    if (target.cascade && !target.gated) {
      const noun = openChildren === 1 ? "sub-task" : "sub-tasks"
      return [{ status, disabled: true, reason: `Has ${openChildren} open ${noun}. Close from the task page` }]
    }
    return [{ status, disabled: target.gated, reason: target.gated ? target.reason : undefined }]
  })
}

export function MoveToMenu({ item, openChildren, onMove }: MoveToMenuProps) {
  const rows = moveRows(item, openChildren)
  // A tap here is not a tap on the card: the menu is portalled, but React events still bubble
  // through it to the card's own click, which opens the Todo.
  return (
    <span className="contents" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid={`board-move-${item.id}`}
            aria-label={`Move ${item.id} to…`}
            className="focus-outline -my-3 -mr-1 grid h-[38px] w-11 flex-none place-items-center rounded-full text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--fill-tertiary)] data-[menu-open]:bg-[var(--fill-tertiary)]"
          >
            <ArrowRightLeft size={15} aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[220px] rounded-[var(--radius-lg)] p-1.5">
          <DropdownMenuLabel className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--text-tertiary)]">
            Move to
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={item.status} aria-label="Move to" onValueChange={(to) => to !== item.status && onMove(item, to as WorkItemStatusWire)}>
            {rows.map((row) => (
              <DropdownMenuRadioItem
                key={row.status}
                value={row.status}
                disabled={row.disabled}
                data-testid={`board-move-${item.id}-${row.status}`}
                className="min-h-11 rounded-[9px] pl-8 pr-2.5 text-[length:var(--text-footnote)] font-medium text-[var(--text-primary)] focus:bg-[var(--fill-secondary)]"
              >
                <span className="flex flex-col items-start">
                  <span className="flex items-center gap-2">
                    <StatusCircle status={row.status} size={18} />
                    {STATUS_LABEL[row.status]}
                  </span>
                  {row.reason && <span className="pl-[26px] text-[11px] font-normal text-[var(--text-tertiary)]">{row.reason}</span>}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
