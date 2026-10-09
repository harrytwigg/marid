import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { api, type WorkItemStatusWire } from "@/lib/api"
import { TODO_WRITE_KEY } from "@/lib/query-keys"
import { TODO_CACHE_ROOTS, refetchTodoPreview } from "@/lib/todo-caches"
import { isPositiveTodoVersion } from "@/lib/todos"
import { mergeTodoIntoCaches } from "./todo-edit-request"

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function setTodoStatus(value: unknown, id: string, status: WorkItemStatusWire): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((entry) => {
      const patched = setTodoStatus(entry, id, status)
      if (patched !== entry) changed = true
      return patched
    })
    return changed ? next : value
  }
  if (!isRecord(value)) return value
  if (value.id === id) return value.status === status ? value : { ...value, status }
  let changed = false
  const next: UnknownRecord = { ...value }
  for (const [key, nested] of Object.entries(value)) {
    const patched = setTodoStatus(nested, id, status)
    if (patched !== nested) {
      next[key] = patched
      changed = true
    }
  }
  return changed ? next : value
}

interface CachedTodoStatus {
  status: WorkItemStatusWire
  version?: number
}

function findTodoStatus(value: unknown, id: string): CachedTodoStatus | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findTodoStatus(entry, id)
      if (found) return found
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (value.id === id && typeof value.status === "string") {
    return {
      status: value.status as WorkItemStatusWire,
      version: isPositiveTodoVersion(value.version) ? value.version : undefined,
    }
  }
  for (const nested of Object.values(value)) {
    const found = findTodoStatus(nested, id)
    if (found) return found
  }
  return undefined
}

function rollbackTodoStatus(
  value: unknown,
  id: string,
  optimisticStatus: WorkItemStatusWire,
  previous: CachedTodoStatus,
): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((entry) => {
      const rolledBack = rollbackTodoStatus(entry, id, optimisticStatus, previous)
      if (rolledBack !== entry) changed = true
      return rolledBack
    })
    return changed ? next : value
  }
  if (!isRecord(value)) return value
  if (value.id === id) {
    if (value.status !== optimisticStatus) return value
    if (previous.version && isPositiveTodoVersion(value.version) && value.version > previous.version) return value
    return { ...value, status: previous.status }
  }
  let changed = false
  const next: UnknownRecord = { ...value }
  for (const [key, nested] of Object.entries(value)) {
    const rolledBack = rollbackTodoStatus(nested, id, optimisticStatus, previous)
    if (rolledBack !== nested) {
      next[key] = rolledBack
      changed = true
    }
  }
  return changed ? next : value
}

export interface TodoCacheSnapshot {
  entries: Array<{ queryKey: QueryKey; previous: CachedTodoStatus }>
}

export interface TodoStatusMutationArgs {
  id: string
  status: WorkItemStatusWire
  note?: string
  /** Close this Todo's open descendants with it (legalTargets' cascade row).
   *  Only the item itself moves in the caches here — the descendants arrive
   *  with the settle invalidation, which is the server's word for all of them. */
  cascade?: boolean
}

type TodoStatusMutationFn = (variables: TodoStatusMutationArgs) => ReturnType<typeof api.setWorkItemStatus>

type TodoStatusMutationResult = Awaited<ReturnType<TodoStatusMutationFn>>

function snapshotTodoCaches(queryClient: QueryClient, id: string): TodoCacheSnapshot {
  const entries: TodoCacheSnapshot["entries"] = []
  for (const root of TODO_CACHE_ROOTS) {
    for (const [queryKey, data] of queryClient.getQueriesData({ queryKey: root })) {
      const previous = findTodoStatus(data, id)
      if (previous) entries.push({ queryKey, previous })
    }
  }
  return { entries }
}

function patchTodoStatusIntoCaches(
  queryClient: QueryClient,
  id: string,
  status: WorkItemStatusWire,
): void {
  for (const root of TODO_CACHE_ROOTS) {
    queryClient.setQueriesData({ queryKey: root }, (current) => setTodoStatus(current, id, status))
  }
}

function restoreTodoCaches(
  queryClient: QueryClient,
  snapshot: TodoCacheSnapshot,
  id: string,
  optimisticStatus: WorkItemStatusWire,
): void {
  for (const { queryKey, previous } of snapshot.entries) {
    queryClient.setQueryData(queryKey, (current: unknown) =>
      rollbackTodoStatus(current, id, optimisticStatus, previous))
  }
}

/** Shared status-write lane for the task surfaces, board drag and the search
 *  workbench. Every cache root that holds a Todo moves together, so a write from one
 *  surface never leaves another showing the pre-write value. */
export function todoStatusMutationOptions(queryClient: QueryClient, mutationFn: TodoStatusMutationFn) {
  return {
    mutationKey: TODO_WRITE_KEY,
    mutationFn,
    onMutate: async ({ id, status }: TodoStatusMutationArgs) => {
      await Promise.all(TODO_CACHE_ROOTS.map((root) => queryClient.cancelQueries({ queryKey: root })))
      const snapshot = snapshotTodoCaches(queryClient, id)
      patchTodoStatusIntoCaches(queryClient, id, status)
      return snapshot
    },
    onSuccess: (data: TodoStatusMutationResult) => {
      // Bank the confirmed revision. Without it a second write of the same move
      // leaves the caches on the pre-write version, and the version fence in
      // rollbackTodoStatus has nothing to weigh the first write's stale snapshot
      // against when that one later fails.
      mergeTodoIntoCaches(queryClient, data.workItem)
    },
    onError: (_error: unknown, variables: TodoStatusMutationArgs, snapshot: TodoCacheSnapshot | undefined) => {
      if (snapshot) restoreTodoCaches(queryClient, snapshot, variables.id, variables.status)
    },
    onSettled: (_data: unknown, _error: unknown, variables: TodoStatusMutationArgs) => {
      void queryClient.invalidateQueries({ queryKey: ["work-items"] })
      void queryClient.invalidateQueries({ queryKey: ["work-item"] })
      // Only this Todo's preview: the transcript around it may hold dozens of
      // other mentions, and none of them changed.
      refetchTodoPreview(queryClient, variables.id)
    },
  }
}
