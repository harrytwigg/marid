import type { WorkItemFullWire } from "@/lib/api"

/**
 * The version-fenced Todo edit lane's wire shapes, its version rule, and the
 * guard that refuses a response it cannot trust.
 *
 * Kept apart from the rest of the client because this lane is the only one that
 * carries an optimistic-concurrency contract: a response without an
 * authoritative version is not a slow edit, it is an edit whose outcome nobody
 * can know. `api.ts` re-exports all of it, so no caller had to move with it —
 * and nothing here imports a VALUE back from `api.ts`, which is what keeps the
 * re-export from reading a function before it exists.
 */

/** A Todo revision is authoritative only when it is a positive safe integer. */
export function isPositiveTodoVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

export interface WorkItemEditPatch {
  title?: string
  body?: string
  assignee?: string | null
  department?: string | null
  priority?: number
  rank?: number
  /** Todos v2 slice 4 (optional: older gateways reject unknown fields). */
  dueAt?: string | null
  startAt?: string | null
}

export interface WorkItemEditRequest {
  patch: WorkItemEditPatch
  expectedVersion: number
  idempotencyKey: string
}

export interface VersionedWorkItemFullWire extends WorkItemFullWire {
  version: number
}

export interface WorkItemEditResultWire {
  workItem: VersionedWorkItemFullWire
  replayed: boolean
}

export function requireWorkItemEditResult(value: unknown): WorkItemEditResultWire {
  if (
    typeof value !== "object"
    || value === null
    || !("workItem" in value)
    || typeof value.workItem !== "object"
    || value.workItem === null
    || !("version" in value.workItem)
    || !isPositiveTodoVersion(value.workItem.version)
  ) {
    throw new Error("Todo edit response has an invalid authoritative version")
  }
  if (!("replayed" in value) || typeof value.replayed !== "boolean") {
    throw new Error("Todo edit response has invalid replay metadata")
  }
  return value as WorkItemEditResultWire
}
