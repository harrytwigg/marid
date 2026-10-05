import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { projectApi, type ProjectInput, type ProjectWire } from "@/lib/project-api"
import { TODO_QUERY_FRESHNESS, TODO_WRITE_KEY } from "@/lib/query-keys"

/* Projects on the web: the registry query and every write against it.
 *
 * The registry lives under the "work-items" key on purpose, as sprints do: a
 * project's Todo count follows every Todo change, and a project event
 * (`company:changed` with entity "project") invalidates that root, so a project
 * created or renamed in another tab shows up here without an event of its own. */

export const PROJECTS_QUERY_KEY = ["work-items", "projects"] as const

export function useProjects(enabled = true) {
  return useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: async (): Promise<ProjectWire[]> => (await projectApi.listProjects()).projects,
    enabled,
    ...TODO_QUERY_FRESHNESS,
  })
}

/** The project a `project` filter value names, or undefined for `none`, an unset filter or an id nobody defines. */
export function resolveProject(projects: ProjectWire[] | undefined, value: string | undefined): ProjectWire | undefined {
  return value && value !== "none" ? projects?.find((p) => p.id === value) : undefined
}

/** The label a `project` filter shows: the project's name, "No project", or the bare id for one that is gone. */
export function projectFilterLabel(value: string | undefined, projects: ProjectWire[] | undefined): string | undefined {
  if (!value) return undefined
  if (value === "none") return "No project"
  return resolveProject(projects, value)?.name ?? "Unknown project"
}

function useProjectWrite<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
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

export function useCreateProject() {
  return useProjectWrite((input: ProjectInput) => projectApi.createProject(input))
}

export function useUpdateProject() {
  return useProjectWrite((args: { id: string; input: ProjectInput }) => projectApi.updateProject(args.id, args.input))
}

/** Move a top-level Todo into a project, or out with null. */
export function useSetTodoProject() {
  return useProjectWrite((args: { id: string; project: string | null }) => projectApi.setWorkItemProject(args.id, args.project))
}
