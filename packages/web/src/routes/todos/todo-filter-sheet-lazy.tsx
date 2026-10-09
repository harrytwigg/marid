import { lazy, Suspense, type ComponentProps } from "react"
import type { TodoFilterSheet as TodoFilterSheetComponent } from "./todo-filter-sheet"

/* The mobile filter sheet is mounted only after someone opens it, so it loads on
 * first open instead of riding in the board and list chunks. */

const TodoFilterSheet = lazy(() => import("./todo-filter-sheet").then((module) => ({ default: module.TodoFilterSheet })))

export function LazyTodoFilterSheet(props: ComponentProps<typeof TodoFilterSheetComponent>) {
  return (
    <Suspense fallback={null}>
      <TodoFilterSheet {...props} />
    </Suspense>
  )
}
