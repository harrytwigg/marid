import { useCallback } from "react"
import { useSearchParams } from "react-router-dom"
import { isHookRunStatus, type HookRunStatus } from "@/lib/api-hooks"
import { isTodoId } from "@/lib/todo-id"

export type HookOutcomeFilter = HookRunStatus | ""

/** The run log's three filters, held in the URL so a filtered log is a link —
 *  the same idiom as the cron page's lens and filter (`use-cron-params.ts`).
 *  Every default is the absent param, and each setter replaces rather than
 *  pushes, so a filter change never costs a back-button press. */
export function useHookRunParams() {
  const [params, setParams] = useSearchParams()
  const hook = params.get("hook") ?? ""
  const rawOutcome = params.get("outcome")
  const outcome: HookOutcomeFilter = isHookRunStatus(rawOutcome) ? rawOutcome : ""
  const todo = (params.get("todo") ?? "").toUpperCase()

  const set = useCallback(
    (key: "hook" | "outcome" | "todo", value: string) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (value) next.set(key, value)
          else next.delete(key)
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  const setHook = useCallback((value: string) => set("hook", value), [set])
  const setOutcome = useCallback((value: HookOutcomeFilter) => set("outcome", value), [set])
  const setTodo = useCallback((value: string) => set("todo", value.toUpperCase()), [set])

  return { hook, outcome, todo, setHook, setOutcome, setTodo }
}

/** The Todo filter as the API takes it: the id when it is whole, else nothing.
 *  A half-typed id stays in the URL and the field but is not sent. */
export function appliedTodo(todo: string): string | undefined {
  return isTodoId(todo) ? todo : undefined
}
