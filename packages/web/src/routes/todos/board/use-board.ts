import { useMemo } from "react"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query"
import {
  api,
  type DepartmentSummaryWire,
  type WorkItemCompactWire,
  type WorkItemStatusWire,
  type WorkItemTreeWire,
} from "@/lib/api"
import { dateBounds, operatorSafeTodoError, type TodoFilters } from "@/lib/todos"
import { TODO_QUERY_FRESHNESS, TODO_WRITE_KEY } from "@/lib/query-keys"
import { todoStatusMutationOptions } from "../todo-status-mutation"
import type { BoardId } from "./board-route"
import { boardKey } from "./board-route"
import { BOARD_STATUS_ORDER, CLOSED_STATUSES, EXCEPTION_STATUSES, isColumnInStatusFilter, PIPELINE_STATUSES } from "./status-scope"

/* Todos v2 slice 6 — the board data layer (design-doc §11 queries).
 * One infinite query per status column, scoped per board:
 *   department    → department=<slug> + rootsOnly
 *   Everything    → rootsOnly (no board-scope filter)
 * True per-column counts come from each query's `total` (the gateway counts the
 * whole filtered set before LIMIT/OFFSET — never a capped page length). */

const OPEN_STATUSES: readonly WorkItemStatusWire[] = [...PIPELINE_STATUSES, ...EXCEPTION_STATUSES]

export const BOARD_PAGE_SIZE = 20

/** Server params for a board scope (pure — unit-tested). Boards show roots
 *  only (§4): children live in the in-place tree tray, not as cards. */
export function boardScopeParams(board: BoardId): { department?: string; rootsOnly: true } {
  if (board.kind === "department") return { department: board.slug, rootsOnly: true }
  return { rootsOnly: true }
}

export interface BoardColumnData {
  status: WorkItemStatusWire
  items: WorkItemCompactWire[]
  /** TRUE server count for this column's scope+filter. */
  total: number
  hasMore: boolean
  loadMore: () => void
  loadingMore: boolean
}

interface BoardPage {
  workItems: WorkItemCompactWire[]
  total: number
  nextOffset: number | null
}

async function fetchBoardPage(
  board: BoardId,
  status: WorkItemStatusWire,
  filters: TodoFilters,
  since: string | undefined,
  until: string | undefined,
  offset: number,
): Promise<BoardPage> {
  const scope = boardScopeParams(board)
  const r = await api.listWorkItems({
    status,
    ...scope,
    // A department board IS its department filter; other chips pass through.
    department: scope.department ?? filters.department,
    assignee: filters.assignee,
    source: filters.source,
    label: filters.label,
    sprint: filters.sprint,
    q: filters.q,
    since,
    until,
    offset,
    limit: BOARD_PAGE_SIZE,
  })
  return { workItems: r.workItems, total: r.total ?? r.workItems.length, nextOffset: r.nextOffset ?? null }
}

export function boardColumnQueryKey(board: BoardId, status: WorkItemStatusWire, filters: TodoFilters): readonly unknown[] {
  return [
    "work-items", "board", boardKey(board), status,
    filters.assignee ?? "", filters.department ?? "", filters.source ?? "", filters.date ?? "",
    filters.label ?? "", filters.sprint ?? "", filters.q ?? "",
  ]
}

function useBoardColumn(board: BoardId, status: WorkItemStatusWire, filters: TodoFilters, now: number, enabled: boolean) {
  const { since, until } = dateBounds(filters.date, now)
  return useInfiniteQuery({
    queryKey: boardColumnQueryKey(board, status, filters),
    queryFn: ({ pageParam }) => fetchBoardPage(board, status, filters, since, until, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    enabled,
    placeholderData: keepPreviousData,
    ...TODO_QUERY_FRESHNESS,
  })
}

type BoardColumnQuery = ReturnType<typeof useBoardColumn>

/** The six columns, assembled from their queries. A disabled column keeps
 *  whatever it last loaded (keepPreviousData), so the status filter gates the
 *  read too — otherwise ?status=executing still shows the backlog cards it
 *  fetched on the way in. */
function boardColumns(
  queries: readonly BoardColumnQuery[],
  inScope: readonly boolean[],
): Record<WorkItemStatusWire, BoardColumnData> {
  const columns = {} as Record<WorkItemStatusWire, BoardColumnData>
  BOARD_STATUS_ORDER.forEach((status, i) => {
    const q = queries[i]
    const pages = inScope[i] ? q.data?.pages ?? [] : []
    columns[status] = {
      status,
      items: pages.flatMap((p) => p.workItems),
      total: pages.length > 0 ? pages[pages.length - 1].total : 0,
      hasMore: inScope[i] && (q.hasNextPage ?? false),
      loadMore: () => {
        if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage()
      },
      loadingMore: q.isFetchingNextPage,
    }
  })
  return columns
}

export interface BoardData {
  /** One entry per status, board order; closed statuses included (the rail pages them). */
  columns: Record<WorkItemStatusWire, BoardColumnData>
  isLoading: boolean
  isError: boolean
  error: unknown
  /** Sum of the three PIPELINE totals — the header's "N open". Blocked
   *  reads out separately (the mock's "11 open · 1 blocked"). */
  openTotal: number
  closedTotal: number
}

export function useBoardData(board: BoardId, filters: TodoFilters, now: number, enabled = true): BoardData {
  // Hooks are unconditional: one query per status in fixed order. A status
  // filter leaves only its own column's query on.
  const on = (status: WorkItemStatusWire) => enabled && isColumnInStatusFilter(filters.status, status)
  const backlog = useBoardColumn(board, "backlog", filters, now, on("backlog"))
  const executing = useBoardColumn(board, "executing", filters, now, on("executing"))
  const inReview = useBoardColumn(board, "in_review", filters, now, on("in_review"))
  const blocked = useBoardColumn(board, "blocked", filters, now, on("blocked"))
  const done = useBoardColumn(board, "done", filters, now, on("done"))
  const cancelled = useBoardColumn(board, "cancelled", filters, now, on("cancelled"))
  const queries = [backlog, executing, inReview, blocked, done, cancelled]

  return useMemo((): BoardData => {
    const inScope = BOARD_STATUS_ORDER.map((status) => isColumnInStatusFilter(filters.status, status))
    const columns = boardColumns(queries, inScope)
    const openTotal = PIPELINE_STATUSES.reduce((sum, s) => sum + columns[s].total, 0)
    const closedTotal = CLOSED_STATUSES.reduce((sum, s) => sum + columns[s].total, 0)
    // Only the columns in scope can settle: an off-filter query stays `pending`
    // forever, and reading it would pin the board to its skeleton.
    const scoped = queries.filter((_, i) => inScope[i])
    const firstError = scoped.find((q) => q.isError)
    return {
      columns,
      isLoading: scoped.some((q) => q.isPending && !q.isPlaceholderData),
      isError: !!firstError,
      error: firstError?.error ?? null,
      openTotal,
      closedTotal,
    }
    // the 6 query results are the dependencies
  }, [filters.status,
      backlog.data, executing.data, inReview.data, blocked.data, done.data, cancelled.data,
      backlog.isFetchingNextPage, executing.isFetchingNextPage, inReview.isFetchingNextPage,
      blocked.isFetchingNextPage, done.isFetchingNextPage, cancelled.isFetchingNextPage,
      // Error/pending flips carry no data change — the states surfaces
      // (skeleton, calm error card) need them as dependencies too.
      backlog.isError, executing.isError, inReview.isError,
      blocked.isError, done.isError, cancelled.isError,
      backlog.isPending, executing.isPending, inReview.isPending,
      blocked.isPending, done.isPending, cancelled.isPending])
}

// ── Switcher data ───────────────────────────────────────────────────────────

/** Open counts for the switcher menu rows, fetched lazily when the menu opens
 *  (one limit-1 query per scope; `totals` carries the truth). */
export function useBoardMenuCounts(departments: DepartmentSummaryWire[] | undefined, enabled: boolean) {
  const slugs = (departments ?? []).map((d) => d.slug)
  return useQuery({
    queryKey: ["work-items", "board-menu-counts", slugs.join(",")],
    enabled: enabled && departments !== undefined,
    ...TODO_QUERY_FRESHNESS,
    queryFn: async (): Promise<{ everything: number; byDepartment: Record<string, number> }> => {
      const openOf = (totals: Partial<Record<WorkItemStatusWire, number>> | undefined): number =>
        OPEN_STATUSES.reduce((sum, s) => sum + (totals?.[s] ?? 0), 0)
      const [everything, ...perDept] = await Promise.all([
        api.listWorkItems({ rootsOnly: true, limit: 1 }),
        ...slugs.map((slug) => api.listWorkItems({ department: slug, rootsOnly: true, limit: 1 })),
      ])
      const byDepartment: Record<string, number> = {}
      slugs.forEach((slug, i) => {
        byDepartment[slug] = openOf(perDept[i].totals)
      })
      return { everything: openOf(everything.totals), byDepartment }
    },
  })
}

// ── Tree enrichment ─────────────────────────────────────────────────────────
// One batch tree fetch for all visible cards: the tree's FULL root row carries
// priority, its totals carry the roll-up counts, and its spendUsd is the
// derived subtree spend. Expansion then renders instantly from the same cache.

export function useBoardTrees(ids: string[]) {
  const key = [...ids].sort().join(",")
  return useQuery({
    queryKey: ["work-items", "board-trees", key],
    enabled: ids.length > 0,
    ...TODO_QUERY_FRESHNESS,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<Map<string, WorkItemTreeWire>> => {
      const { trees } = await api.getWorkItemTrees(ids)
      return new Map(Object.entries(trees))
    },
  })
}

// ── Mutations (drag commits) ────────────────────────────────────────────────

/** Cross-column drop = a status transition on the operator PUT lane. The UI
 *  pre-checked legality; a runtime refusal surfaces the gateway's words. */
export function useBoardTransition() {
  const qc = useQueryClient()
  return useMutation(todoStatusMutationOptions(
    qc,
    ({ id, status }) => api.setWorkItemStatus(id, status),
  ))
}

/** Within-column drop = a rank edit through the metadata pen (CAS-guarded). */
export function useBoardRank() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: TODO_WRITE_KEY,
    mutationFn: ({ id, rank, expectedVersion }: { id: string; rank: number; expectedVersion: number }) =>
      api.updateWorkItem(id, {
        patch: { rank },
        expectedVersion,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["work-items"] })
    },
  })
}

/** Put a Todo on Home, or take it off (ICI-1357). Invalidates every Todo query
 *  (unkeeping removes the card) and announces a refusal — nothing else shows one. */
export function useKeepWorkItem(announce: (message: string) => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: TODO_WRITE_KEY,
    mutationFn: ({ id, kept }: { id: string; kept: boolean }) => api.setWorkItemKept(id, kept),
    onError: (error) => announce(operatorSafeTodoError(error, "The gateway refused to change what Home keeps")),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["work-items"] })
    },
  })
}

/** The tray's quick add — a sub-task born in backlog under its parent. */
export function useCreateSubTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: TODO_WRITE_KEY,
    mutationFn: ({ parentId, title }: { parentId: string; title: string }) =>
      api.createWorkItem({ title, parentId }),
    onSettled: (_data, _error, { parentId }) => {
      void qc.invalidateQueries({ queryKey: ["work-items"] })
      void qc.invalidateQueries({ queryKey: ["work-item-tree", parentId] })
    },
  })
}

/** Ids worth enriching with detail (spend, priority, reason, session) — the
 *  open-details pattern the ledger already pays for; bounded for calm. */
export function boardDetailIds(columns: Record<WorkItemStatusWire, BoardColumnData>, cap = 60): string[] {
  const ids: string[] = []
  for (const status of BOARD_STATUS_ORDER) {
    for (const item of columns[status]?.items ?? []) {
      ids.push(item.id)
      if (ids.length >= cap) return ids
    }
  }
  return ids
}
