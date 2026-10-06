import { authFetch } from "@/lib/auth"
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
  /** Skills the allow-list names that the stage directory refuses, each with why (a symlink inside one, say). They are not in `skills`. */
  skillProblems?: Array<{ skill: string; reason: string }>
}

/** A Todo that would be stranded by a scope change: who holds it. */
export interface DepartmentHolderWire {
  todo: string
  assignee: string
}

/** A refused PATCH. `holders` is set on a `department-boundary` refusal, which
 *  `ApiError` has no room for, so the body is read here. */
export class DepartmentPatchError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly holders: DepartmentHolderWire[] = [],
  ) {
    super(message)
    this.name = "DepartmentPatchError"
  }
}

function holdersOf(value: unknown): DepartmentHolderWire[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => (row && typeof row.todo === "string" && typeof row.assignee === "string" ? [{ todo: row.todo, assignee: row.assignee }] : []))
}

export const departmentApi = {
  get: async (slug: string): Promise<DepartmentDefinitionWire> =>
    (await get<{ department: DepartmentDefinitionWire }>(`/api/departments/${encodeURIComponent(slug)}`)).department,
  /** Changes a department's scope. Operator only. */
  patch: async (slug: string, body: { scope: DepartmentScopeWire }): Promise<DepartmentDefinitionWire> => {
    const res = await authFetch(`/api/departments/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as { department?: DepartmentDefinitionWire; error?: unknown; code?: unknown; holders?: unknown } | null
    if (!res.ok || !json?.department) {
      throw new DepartmentPatchError(res.status, typeof json?.error === "string" ? json.error : `API error: ${res.status}`, typeof json?.code === "string" ? json.code : undefined, holdersOf(json?.holders))
    }
    return json.department
  },
}

/** Whether a department confines anyone: open departments show no badge. */
export function isConfined(scope: DepartmentScopeWire | undefined): scope is "scoped" | "dedicated" {
  return scope === "scoped" || scope === "dedicated"
}
