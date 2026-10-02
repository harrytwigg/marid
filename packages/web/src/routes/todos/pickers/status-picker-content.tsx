import type { WorkItemStatusWire } from "@/lib/api"
import { STATUS_LABEL } from "@/lib/todos"
import { legalTargets } from "@/lib/legal-targets"
import { StatusCircle } from "../state-glyph"
import type { PickerContentProps } from "./picker-contents"
import { PickerNote, PickerRow } from "./picker-shell"

/* The one picker with a rule in it, which is why it sits apart from the plain
 * lists next door: it consumes the same legalTargets() module as board drag —
 * one legality truth, no client carve-outs — and says out loud which statuses
 * the current one cannot reach.
 *
 * `showCurrent` is what the two shells disagree about. The task page's popover
 * superimposes the current value's row on its anchor (law 1), so that row leads
 * the menu, checked; a shell with no anchor to cover passes false and lists
 * moves only. */

const ALL_STATUSES: readonly WorkItemStatusWire[] = [
  "backlog", "executing", "in_review", "done", "blocked", "cancelled",
]

/** The design's presentation order (§7.3 + the popover mock): pipeline first,
 *  then Done, then the exception/closed states — regardless of legalTargets()
 *  enumeration order. Mockup wins (stage-B review F2). */
const STATUS_DISPLAY_ORDER: readonly WorkItemStatusWire[] = [
  "backlog", "executing", "in_review", "done", "blocked", "cancelled",
]

/** The close gate's counts (see legal-targets.ts) travel as the rest of the
 *  props: a surface that knows only its direct children passes `openChildren`
 *  alone and the module falls back to it. */
interface StatusPickerProps {
  openChildren: number
  openDescendants?: number
  commit: (status: WorkItemStatusWire, options?: { cascade?: boolean }) => void
  showCurrent?: boolean
}

export function StatusPickerContent({
  detail,
  commit,
  sheet,
  showCurrent = true,
  onDone,
  ...gate
}: PickerContentProps & StatusPickerProps) {
  const from = detail.workItem.status
  const targets = legalTargets(from, gate)
    .filter((t) => t.status !== from)
    .sort((a, b) => STATUS_DISPLAY_ORDER.indexOf(a.status) - STATUS_DISPLAY_ORDER.indexOf(b.status))
  const omitted = ALL_STATUSES.filter((s) => s !== from && !targets.some((t) => t.status === s))
  return (
    <>
      {showCurrent && (
        <PickerRow
          sheet={sheet}
          glyph={<StatusCircle status={from} size={18} />}
          label={STATUS_LABEL[from]}
          checked
          onSelect={onDone}
          testId={`status-option-${from}`}
        />
      )}
      {targets.map((target) => (
        <PickerRow
          key={target.status}
          sheet={sheet}
          glyph={<StatusCircle status={target.status} size={18} />}
          label={STATUS_LABEL[target.status]}
          disabled={target.gated}
          reason={target.reason}
          sub={target.gated ? undefined : target.reason}
          onSelect={() => {
            commit(target.status, target.cascade ? { cascade: true } : undefined)
            onDone()
          }}
          testId={`status-option-${target.status}`}
        />
      ))}
      {omitted.length > 0 && (
        <PickerNote>
          Only legal moves are listed — {omitted.map((s) => STATUS_LABEL[s]).join(" and ")}{" "}
          {omitted.length === 1 ? "isn't" : "aren't"} reachable from {STATUS_LABEL[from]}.
        </PickerNote>
      )}
    </>
  )
}
