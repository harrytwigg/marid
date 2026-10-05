import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { TODO_QUERY_FRESHNESS } from "@/lib/query-keys"
import { useActiveProject } from "@/hooks/use-active-project"
import { useProjects } from "@/hooks/use-projects"

/* What the active project narrows the chat list to: the sessions whose linked
 * Todo is one of the project's Todos. */

const PAGE_SIZE = 100
const MAX_PAGES = 20

/** Every Todo id in a project (sub-tasks included), following the list's pages up to a cap. */
export async function fetchProjectTodoIds(projectId: string, signal?: AbortSignal): Promise<{ ids: string[] }> {
  const ids: string[] = []
  let offset: number | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await api.listWorkItems({ project: projectId, limit: PAGE_SIZE, offset }, signal)
    for (const item of result.workItems) ids.push(item.id)
    if (result.nextOffset == null) break
    offset = result.nextOffset
  }
  return { ids }
}

export interface ProjectScope {
  /** The project the list is narrowed to, or undefined when it is not narrowed at all. */
  projectId: string | undefined
  /** The project's Todo ids once known. Undefined while loading or when the read failed. */
  todoIds: ReadonlySet<string> | undefined
}

export function useProjectScope(): ProjectScope {
  const active = useActiveProject()
  const real = active && active !== "none" ? active : undefined
  const projects = useProjects(Boolean(real))
  // With no projects defined (or the registry unreadable) a leftover choice must not hide every chat.
  const unusable = projects.isError || (projects.isSuccess && projects.data.length === 0)
  const projectId = unusable ? undefined : real
  const ids = useQuery({
    queryKey: ["work-items", "project-todo-ids", projectId ?? ""],
    queryFn: ({ signal }) => fetchProjectTodoIds(projectId!, signal),
    enabled: Boolean(projectId),
    ...TODO_QUERY_FRESHNESS,
  })
  return useMemo(() => ({ projectId, todoIds: ids.data ? new Set(ids.data.ids) : undefined }), [projectId, ids.data])
}

/** The sessions of the scope's project. Unnarrowed while the Todo ids are still unknown. */
export function narrowToProject<T extends object>(sessions: T[], scope: ProjectScope): T[] {
  const { projectId, todoIds } = scope
  if (!projectId || !todoIds) return sessions
  return sessions.filter((session) => {
    const todoId = (session as { workItemId?: unknown }).workItemId
    return typeof todoId === "string" && todoIds.has(todoId)
  })
}
