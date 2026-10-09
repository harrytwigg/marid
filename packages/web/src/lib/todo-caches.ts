import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { forgetTodoPreview } from "@/lib/todo-preview"

/* Which React Query roots hold a copy of a Todo, written down once. React Query
 * compares keys element-wise, so ['work-item-preview'] is NOT prefix-matched by
 * ['work-item'] — a write lane that names only the latter leaves the mention
 * glance strip showing the pre-write value. */

/** Every root a Todo row can be found under, for snapshot/patch/invalidate. */
export const TODO_CACHE_ROOTS: readonly QueryKey[] = [
  ["work-items"],
  ["work-item"],
  ["work-item-preview"],
]

/** Make one Todo's preview ask the gateway again. The query key alone is not
 *  enough: the mention queryFn resolves out of a module-level promise map that
 *  sits behind React Query, so a refetch hands back the same stale promise
 *  unless the id is dropped there first. */
export function refetchTodoPreview(queryClient: QueryClient, id: string): void {
  forgetTodoPreview(id)
  void queryClient.invalidateQueries({ queryKey: ["work-item-preview", id], exact: true })
}
