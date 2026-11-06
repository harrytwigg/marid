import { Check, RotateCcw } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import type { WorkItemStatusWire } from "@/lib/api"

/** A member's two status moves, in the only trees they may write: To do → Done and Done → To do.
 *  It stands in for the status picker, which offers edges a member does not have. Done is refused
 *  while sub-tasks are open: members have no cascade. */
export function MemberCloseControl({
  status,
  openChildren,
  onSet,
}: {
  status: WorkItemStatusWire
  openChildren: number
  onSet: (status: WorkItemStatusWire) => void
}) {
  if (status !== "backlog" && status !== "done") return null
  const closing = status === "backlog"
  const blocked = closing && openChildren > 0
  return (
    <div className="mt-3 flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        data-testid={closing ? "task-mark-done" : "task-reopen"}
        disabled={blocked}
        onClick={() => onSet(closing ? "done" : "backlog")}
        className="rounded-full"
      >
        {closing ? <Check size={14} aria-hidden /> : <RotateCcw size={14} aria-hidden />}
        {closing ? "Mark done" : "Reopen"}
      </Button>
      {blocked && (
        <span className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
          {openChildren} sub-task{openChildren === 1 ? "" : "s"} still open
        </span>
      )}
    </div>
  )
}
