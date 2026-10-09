import { useCallback, useEffect, useState } from "react"
import type { Employee, WorkItemStatusWire } from "@/lib/api"
import { useAddTodoComment } from "@/routes/todos/use-todo-comment"
import { useEmployeesByName, useOrg, useTodoById } from "@/routes/todos/use-todos"
import { displayNameOf } from "@/routes/todos/util"
import {
  useTodoQuickPickers,
  type Refusal,
  type TodoQuickPickerKey,
  type TodoQuickPickerRow,
} from "@/routes/todos/pickers/use-todo-quick-pickers"
import type { SearchRow } from "./rows"

/* Everything the workbench can do to the selected Todo, and nothing it can do
 * to anything else. Status and owner come from the shared quick-picker lane,
 * and the comment from the lane the task page's
 * own composer sends on — so this surface adds a place to act from, never a
 * second copy of the acting. A row of any other kind resolves to `undefined`
 * here, which is what keeps the preview read-only for it. */

/** Names this surface's anchors and pickers (see `useTodoQuickPickers`). */
export const WORKBENCH_PREFIX = "workbench"

const NO_EMPLOYEES: Employee[] = []
const employeesOf = (org: { employees: Employee[] } | undefined): Employee[] => org?.employees ?? NO_EMPLOYEES

export interface TodoWorkbench {
  id: string
  /** Read from the same `["work-item"]` cache the status lane patches
   *  optimistically and rolls back on refusal, which is what moves the result
   *  row and this preview together without a second patcher. */
  status: WorkItemStatusWire | undefined
  /** The owner as the rest of Jinn writes it — the roster's display name, not
   *  the employee key the wire carries. */
  assignee: string | null | undefined
  /** The detail is still on its way; the controls have nothing to act on yet. */
  loading: boolean
  /** The gateway has answered, and there is no such Todo any more. */
  missing: boolean
  /** The org's employees, for the composer's @mention picker. */
  employees: Employee[]
  /** The composer's @mention list is a picker too: it tells the overlay while it
   *  is up, so one Escape closes the list and nothing else. */
  onPickerOpenChange: (open: boolean) => void
  rowFor: (key: TodoQuickPickerKey) => TodoQuickPickerRow
  /** The one refusal line — a picker's or the composer's, whichever spoke last. */
  error: string | null
  comment: {
    draft: string
    setDraft: (value: string) => void
    submit: () => void
    pending: boolean
  }
}

/** The id the workbench may act on — a Todo row's, and nobody else's. */
function todoIdOf(row: SearchRow | undefined): string | null {
  return row && row.kind === "todo" ? row.result.id : null
}

/** The composer, reporting through the pickers' own refusal line. A draft
 *  belongs to the row that produced it, so moving the selection drops it rather
 *  than posting one Todo's words onto another. */
function useCommentLane(id: string | null, refusal: Refusal): TodoWorkbench["comment"] {
  const send = useAddTodoComment(id ?? "")
  const [draft, setDraft] = useState("")

  const { clear } = refusal
  useEffect(() => {
    setDraft("")
    clear()
  }, [id, clear])

  const submit = useCallback(() => {
    const body = draft.trim()
    if (body.length === 0 || send.isPending) return
    refusal.clear()
    send.mutate({ body }, {
      onSuccess: () => setDraft(""),
      onError: (cause) => refusal.fromGateway(cause, "Couldn't post the comment"),
    })
  }, [draft, send, refusal])

  return { draft, setDraft, submit, pending: send.isPending }
}

export function useTodoWorkbench(
  row: SearchRow | undefined,
  /** Told while a picker is up, so the overlay can stand its own Escape down.
   *  Radix listens in the same capture phase the picker does, so the picker's
   *  stopPropagation() never reaches it. */
  onPickerOpenChange: (open: boolean) => void,
): TodoWorkbench | undefined {
  const id = todoIdOf(row)
  const detailQuery = useTodoById(id)
  const detail = detailQuery.data ?? undefined
  const org = useOrg()
  const employees = employeesOf(org.data)
  const byName = useEmployeesByName(employees)
  const pickers = useTodoQuickPickers({
    detail,
    employees,
    prefix: WORKBENCH_PREFIX,
    onOpenChange: onPickerOpenChange,
  })
  const comment = useCommentLane(id, pickers.refusal)

  const assignee = detail?.workItem.assignee
  if (!id) return undefined
  return {
    id,
    status: detail?.workItem.status,
    assignee: assignee ? displayNameOf(assignee, byName) : assignee,
    loading: detailQuery.isPending,
    missing: !detailQuery.isPending && !detail,
    employees,
    onPickerOpenChange,
    rowFor: pickers.rowFor,
    error: pickers.refusal.message,
    comment,
  }
}
