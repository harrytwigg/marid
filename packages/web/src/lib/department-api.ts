import { get, type DepartmentSummaryWire } from "./api"

/* The department routes' wire shapes and client calls. Kept beside api.ts rather
 * than inside it: the board only needs a row's slug and prefix, and the definition
 * fields are used by the scope badges and the department panel alone. Every field
 * the gateway added is optional here, so an older gateway still renders. */

export type DepartmentScopeWire = "open" | "scoped" | "dedicated"

/** A GET /api/departments row: the registry row plus the department's definition. */
export interface DepartmentRowWire extends DepartmentSummaryWire {
  scope?: DepartmentScopeWire
  displayName?: string | null
  description?: string | null
  members?: string[]
  /** The file, relative to the instance home; null when the department has none. */
  definitionFile?: string | null
  /** Why `department.yaml` was refused; the scope shown is then the last good one. */
  definitionError?: string | null
}

/** GET /api/departments/:slug: one department in full. */
export interface DepartmentDefinitionWire {
  slug: string
  prefix: string | null
  scope: DepartmentScopeWire
  displayName: string | null
  description: string | null
  members: string[]
  definitionFile: string | null
  definitionError: string | null
  workdirs: string[]
  skills: string[]
  sharedNotes: string[]
  instructions: "department" | "department+company"
  todoCount: number
  spendUsd: number
  /** Entries the scan dropped, each with its reason. */
  warnings: string[]
}

export const departmentApi = {
  get: async (slug: string): Promise<DepartmentDefinitionWire> =>
    (await get<{ department: DepartmentDefinitionWire }>(`/api/departments/${encodeURIComponent(slug)}`)).department,
}

/** Whether a department confines anyone: open departments show no badge. */
export function isConfined(scope: DepartmentScopeWire | undefined): scope is "scoped" | "dedicated" {
  return scope === "scoped" || scope === "dedicated"
}
