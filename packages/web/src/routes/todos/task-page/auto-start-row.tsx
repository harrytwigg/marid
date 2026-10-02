import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { WorkItemDetailWire } from "@/lib/api"
import { dispatchConfigOf, setTodoAutoStart } from "@/lib/api-dispatch-config"
import { ToggleSwitch } from "@/routes/settings/shared"
import { invalidateTodoCaches } from "../todo-edit-request"

/** The label that also keeps a Todo out of every automatic start — the
 *  board walk's and the assignment auto-start's. */
const OPT_OUT_LABEL = "no-auto-start"

/**
 * The Todo's auto-start switch (User Story 5). The rule already lives
 * in the gateway — the board walk never starts a Todo whose dispatch config
 * says `autoStart: false` — and the route already exists; this is the first
 * place the dashboard shows or sets it. Off is the exception to the global
 * policy for this one Todo.
 */
export function AutoStartRow({ detail }: { detail: WorkItemDetailWire }) {
  const qc = useQueryClient()
  const id = detail.workItem.id
  const autoStart = dispatchConfigOf(detail)?.autoStart ?? true
  const labelled = (detail.labels ?? []).some((label) => label.name === OPT_OUT_LABEL)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = async (next: boolean) => {
    setPending(true)
    setError(null)
    try {
      await setTodoAutoStart(id, next)
      await invalidateTodoCaches(qc, id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update auto-start")
    } finally {
      setPending(false)
    }
  }

  return (
    <div data-testid="rail-auto-start" className="-mx-2.5 flex items-center gap-[9px] rounded-[9px] px-2.5 py-1 text-[13.5px]">
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-[var(--text-primary)]">Auto-start</span>
        <span className="block text-[11.5px] text-[var(--text-tertiary)]">
          {error ?? (labelled
            ? `Off by label: ${OPT_OUT_LABEL} keeps every automatic start away, whatever this switch says`
            : autoStart ? "The board walk may start this Todo" : "The board walk never starts this Todo")}
        </span>
      </span>
      <span className={pending ? "opacity-50" : undefined}>
        <ToggleSwitch checked={autoStart} disabled={pending} onChange={(value) => { void toggle(value) }} ariaLabel="Auto-start this Todo" />
      </span>
    </div>
  )
}
