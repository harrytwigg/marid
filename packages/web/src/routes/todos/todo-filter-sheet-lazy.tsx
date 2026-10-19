import { lazy, Suspense, type ComponentProps } from "react"
import { LoadBoundary } from "@/components/ui/lazy-overlay"
import type { TodoFilterSheet as TodoFilterSheetComponent } from "./todo-filter-sheet"

/* The mobile filter sheet is mounted only after someone opens it, so it loads on
 * first open instead of riding in the board and list chunks. If the chunk cannot
 * be fetched the sheet closes and the app's notice surface says so. */

const TodoFilterSheet = lazy(() => import("./todo-filter-sheet").then((module) => ({ default: module.TodoFilterSheet })))

export function LazyTodoFilterSheet(props: ComponentProps<typeof TodoFilterSheetComponent>) {
  return (
    <LoadBoundary what="The filter sheet" onFailed={props.onClose}>
      <Suspense fallback={null}>
        <TodoFilterSheet {...props} />
      </Suspense>
    </LoadBoundary>
  )
}
