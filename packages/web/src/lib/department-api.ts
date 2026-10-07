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
  /** Instance MCP servers the department's sessions get beside `jinn`. */
  mcp: string[]
  sharedNotes: string[]
  instructions: "department" | "department+company"
  todoCount: number
  spendUsd: number
  /** Entries the scan dropped, each with its reason. */
  warnings: string[]
  /** Skills the allow-list names that the stage directory refuses, each with why (a symlink inside one, say). They are not in `skills`. */
  skillProblems?: Array<{ skill: string; reason: string }>
  /** MCP servers the allow-list names that this instance does not configure, each with why. They are not in `mcp`. */
  mcpProblems?: Array<{ server: string; reason: string }>
  archived?: boolean
  archivedAt?: string | null
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

/** An archive the gateway would not do as asked. `department-archive-confirm` means the
 *  department still has members or open Todos, and the operator has to confirm it. */
export class DepartmentArchiveError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly members: string[] = [],
    readonly openTodos = 0,
  ) {
    super(message)
    this.name = "DepartmentArchiveError"
  }
}

async function postArchive(slug: string, action: "archive" | "unarchive", body: { confirm?: boolean }): Promise<DepartmentDefinitionWire> {
  const res = await authFetch(`/api/departments/${encodeURIComponent(slug)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as ArchiveResponse | null
  if (!res.ok || !json?.department) throw archiveErrorOf(res.status, json ?? {})
  return json.department
}

type ArchiveResponse = { department?: DepartmentDefinitionWire; error?: unknown; code?: unknown; members?: unknown; openTodos?: unknown }

function archiveErrorOf(status: number, body: ArchiveResponse): DepartmentArchiveError {
  return new DepartmentArchiveError(
    status,
    typeof body.error === "string" ? body.error : `API error: ${status}`,
    typeof body.code === "string" ? body.code : undefined,
    Array.isArray(body.members) ? body.members.filter((name): name is string => typeof name === "string") : [],
    typeof body.openTodos === "number" ? body.openTodos : 0,
  )
}

export const departmentApi = {
  /** Archives a department; `confirm` is needed while it has members or open Todos. Operator only. */
  archive: (slug: string, confirm = false) => postArchive(slug, "archive", confirm ? { confirm: true } : {}),
  /** Takes a department out of the archive. Operator only. */
  unarchive: (slug: string) => postArchive(slug, "unarchive", {}),
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
