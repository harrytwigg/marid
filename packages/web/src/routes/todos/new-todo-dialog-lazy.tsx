import { lazy, Suspense, type ComponentProps } from "react"
import { LoadBoundary, LoadingScrim, useIdlePreload } from "@/components/ui/lazy-overlay"
import type { NewTodoDialog as NewTodoDialogComponent } from "./new-todo-dialog"

/* The board opens the new-Todo dialog on a press, so the dialog (its pickers, the modal it is drawn in and their
 * code) is not in the board's chunk: it loads when the page is idle, and when a button that opens it is hovered,
 * focused or touched. A press before that still works: an inert scrim in the dialog's own overlay stands in
 * until the chunk lands, and if the chunk cannot be fetched the scrim is taken down, the notice surface says so and the caller is told. */

const load = () => import("./new-todo-dialog")
const NewTodoDialog = lazy(() => load().then((module) => ({ default: module.NewTodoDialog })))

/** Starts the fetch; a failed one is reported to whoever opens the dialog, not here. */
export function preloadNewTodoDialog(): void {
  void load().catch(() => {})
}

/** Props that start the fetch from a button that opens the dialog. */
export const NEW_TODO_PRELOAD = {
  onPointerEnter: preloadNewTodoDialog,
  onFocus: preloadNewTodoDialog,
  onTouchStart: preloadNewTodoDialog,
} as const

/** Fetches the dialog once the page has settled, so the first press finds it loaded. */
export function usePreloadNewTodoDialog(): void {
  useIdlePreload(preloadNewTodoDialog)
}

export function LazyNewTodoDialog({ onFailed, ...props }: ComponentProps<typeof NewTodoDialogComponent> & { onFailed: () => void }) {
  return (
    <LoadBoundary what="The new Todo dialog" onFailed={onFailed}>
      <Suspense fallback={<LoadingScrim testId="todo-new-loading" />}>
        <NewTodoDialog {...props} />
      </Suspense>
    </LoadBoundary>
  )
}
