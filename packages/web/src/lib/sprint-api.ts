import { del, patch, post, put, get } from "./api"

/* The sprint routes' wire shapes and client calls. Kept beside api.ts rather
 * than inside it: the Todo rows only carry a sprint reference, and the rest of
 * the sprint surface is used by the sprint planner alone. */

export type SprintStatusWire = "planned" | "active" | "closed"

/** What a Todo row carries about its sprint (a sub-task carries its root's). */
export interface WorkItemSprintRefWire {
  id: string
  name: string
  status: SprintStatusWire
}

/** A sprint from the registry, with its top-level Todos counted. */
export interface SprintWire extends WorkItemSprintRefWire {
  goal: string | null
  startsAt: string | null
  endsAt: string | null
  createdAt: string
  startedAt: string | null
  closedAt: string | null
  /** Top-level Todos not yet done or cancelled. */
  open: number
  total: number
}

export const sprintApi = {
  /** The sprint registry: active first, then planned, then closed. */
  listSprints: () => get<{ sprints: SprintWire[] }>("/api/sprints"),
  createSprint: (input: { name: string; goal?: string | null; startsAt?: string | null; endsAt?: string | null }) =>
    post<{ sprint: SprintWire }>("/api/sprints", input),
  updateSprint: (id: string, input: { name?: string; goal?: string | null; startsAt?: string | null; endsAt?: string | null }) =>
    patch<{ sprint: SprintWire }>(`/api/sprints/${encodeURIComponent(id)}`, input),
  startSprint: (id: string) => post<{ sprint: SprintWire }>(`/api/sprints/${encodeURIComponent(id)}/start`),
  /** Close the active sprint; unfinished Todos go to `carryTo` (a planned sprint) or, with null, out of any sprint. */
  completeSprint: (id: string, input: { carryTo: string | null; startNext?: boolean }) =>
    post<{ sprint: SprintWire; carried: string[]; carriedTo: SprintWire | null }>(`/api/sprints/${encodeURIComponent(id)}/complete`, input),
  deleteSprint: (id: string) => del<{ deleted: boolean; moved: string[] }>(`/api/sprints/${encodeURIComponent(id)}`),
  /** Move a top-level Todo into a sprint (id or name), or out with null. */
  setWorkItemSprint: (id: string, sprint: string | null) =>
    put<{ sprint: WorkItemSprintRefWire | null; version: number }>(`/api/work-items/${encodeURIComponent(id)}/sprint`, { sprint }),
}
