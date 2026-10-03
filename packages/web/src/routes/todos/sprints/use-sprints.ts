import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { sprintApi as api, type SprintWire } from "@/lib/sprint-api"
import { TODO_QUERY_FRESHNESS, TODO_WRITE_KEY } from "@/lib/query-keys"

/* Sprints on the web: the registry query and every write against it.
 *
 * The registry lives under the "work-items" key on purpose. Moving a Todo
 * changes a sprint's open/total counts, and every Todo change already
 * invalidates ["work-items"], so the counts follow without a sprint event of
 * their own. Each write invalidates the same root, because a sprint write
 * moves Todos (complete, delete) or changes what a sprint filter matches. */

export const SPRINTS_QUERY_KEY = ["work-items", "sprints"] as const

export function useSprints(enabled = true) {
  return useQuery({
    queryKey: SPRINTS_QUERY_KEY,
    queryFn: async (): Promise<SprintWire[]> => (await api.listSprints()).sprints,
    enabled,
    ...TODO_QUERY_FRESHNESS,
  })
}

/** The sprint a `sprint` filter value names: an id, or `active` for the running one. */
export function resolveSprintFilter(sprints: SprintWire[] | undefined, value: string | undefined): SprintWire | undefined {
  if (!value || value === "none") return undefined
  if (value === "active") return sprints?.find((s) => s.status === "active")
  return sprints?.find((s) => s.id === value || s.name.toLowerCase() === value.toLowerCase())
}

/** Human date range for a sprint, or null when it has no dates. */
export function sprintDates(sprint: Pick<SprintWire, "startsAt" | "endsAt">): string | null {
  const fmt = (day: string) =>
    new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })
  if (sprint.startsAt && sprint.endsAt) return `${fmt(sprint.startsAt)} – ${fmt(sprint.endsAt)}`
  if (sprint.endsAt) return `ends ${fmt(sprint.endsAt)}`
  if (sprint.startsAt) return `from ${fmt(sprint.startsAt)}`
  return null
}

function useSprintWrite<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: TODO_WRITE_KEY,
    mutationFn: fn,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["work-items"] })
      void qc.invalidateQueries({ queryKey: ["work-item"] })
    },
  })
}

export function useCreateSprint() {
  return useSprintWrite((input: { name: string; goal?: string | null; startsAt?: string | null; endsAt?: string | null }) =>
    api.createSprint(input))
}

export function useUpdateSprint() {
  return useSprintWrite(({ id, ...input }: { id: string; name?: string; goal?: string | null; startsAt?: string | null; endsAt?: string | null }) =>
    api.updateSprint(id, input))
}

export function useStartSprint() {
  return useSprintWrite((id: string) => api.startSprint(id))
}

export function useCompleteSprint() {
  return useSprintWrite(({ id, carryTo, startNext }: { id: string; carryTo: string | null; startNext?: boolean }) =>
    api.completeSprint(id, { carryTo, startNext }))
}

export function useDeleteSprint() {
  return useSprintWrite((id: string) => api.deleteSprint(id))
}

/** Move one top-level Todo into a sprint (id), or out with null. */
export function useSetWorkItemSprint() {
  return useSprintWrite(({ id, sprint }: { id: string; sprint: string | null }) => api.setWorkItemSprint(id, sprint))
}

/** What the Sprint chip reads when set. A sprint the registry no longer lists
 *  still reads as set, so the operator can see why the board is empty. */
export function sprintFilterLabel(value: string | undefined, sprints: SprintWire[] | undefined): string | undefined {
  if (!value) return undefined
  if (value === "none") return "No sprint"
  const sprint = resolveSprintFilter(sprints, value)
  if (value === "active") return sprint ? `${sprint.name} (active)` : "Active sprint"
  return sprint?.name ?? "Sprint"
}

/** The sprints a filter offers: every open one, then the five most recently
 *  closed (the registry lists closed sprints newest first). */
export function sprintChoices(sprints: SprintWire[] | undefined): SprintWire[] {
  const all = sprints ?? []
  return [...all.filter((s) => s.status !== "closed"), ...all.filter((s) => s.status === "closed").slice(0, 5)]
}
