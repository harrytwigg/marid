import { get, patch, post, put } from "./api"

/* The project routes' wire shapes and client calls. Kept beside api.ts rather
 * than inside it: a Todo row only carries a project reference, and the rest of
 * the project surface belongs to the Projects page and the pickers. */

/** What a Todo row carries about its project (a sub-task carries its root's). */
export interface ProjectRefWire {
  id: string
  name: string
  archived: boolean
  /** False when no definition file names this id: the row shows an "unknown project". */
  known: boolean
}

/** A project from the registry, with live counts. */
export interface ProjectWire extends ProjectRefWire {
  description: string
  /** Read-only until scoped employees exist: the API refuses writes to it. */
  dedicated: boolean
  instructions: "project" | "project+company"
  workdirs: string[]
  skills: string[]
  sharedNotes: string[]
  /** Employees scoped to the project. */
  members: string[]
  todoCount: number
  spendUsd: number
  /** The defining YAML file, relative to the instance home. */
  file: string
  /** Things worth a look, such as an id that was previously used under another name. */
  notices: string[]
}

export interface ProjectInput {
  name?: string
  description?: string
  archived?: boolean
  workdirs?: string[]
  skills?: string[]
  sharedNotes?: string[]
  instructions?: "project" | "project+company"
}

// The Todo wires gain the project, additively. Declared here so api.ts stays within its size budget.
declare module "./api" {
  interface WorkItemCompactWire {
    /** The Todo's project — a sub-task's is its root's. Null for company-level (optional: older gateways omit it). */
    project?: ProjectRefWire | null
  }
  interface WorkItemDetailWire {
    project?: ProjectRefWire | null
  }
}

export const projectApi = {
  listProjects: () => get<{ projects: ProjectWire[] }>("/api/projects"),
  getProject: (id: string) => get<{ project: ProjectWire }>(`/api/projects/${encodeURIComponent(id)}`),
  createProject: (input: ProjectInput) => post<{ project: ProjectWire }>("/api/projects", input),
  updateProject: (id: string, input: ProjectInput) =>
    patch<{ project: ProjectWire }>(`/api/projects/${encodeURIComponent(id)}`, input),
  /** Move a top-level Todo into a project, or out with null. */
  setWorkItemProject: (id: string, project: string | null) =>
    put<{ project: ProjectRefWire | null; version: number }>(`/api/work-items/${encodeURIComponent(id)}/project`, { project }),
}
