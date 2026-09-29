import { ApiError, type WorkItemDetailWire } from "@/lib/api"
import { authFetch } from "@/lib/auth"

/**
 * A Todo's dispatch config, as far as the dashboard touches it (User
 * Story 5): the auto-start flag. A leaf beside `api.ts`, which is at its size
 * budget and does not yet name `dispatchConfig` on the detail payload.
 */

/** `dispatchConfig` as `GET /api/work-items/:id` carries it. */
export interface WorkItemDispatchConfigWire {
  /** False keeps every automatic start away from the Todo — the idle-capacity
   *  loop's, and the assignment Workflow's when its trigger filters on it. */
  autoStart: boolean
  engine?: string | null
  model?: string | null
  skills?: string[]
}

/** The detail payload carries the field; the wire type in `api.ts` does not
 *  spell it yet (that file is at its ratchet budget), so it is read here. */
export function dispatchConfigOf(detail: WorkItemDetailWire): WorkItemDispatchConfigWire | null {
  const carried = (detail as Partial<{ dispatchConfig: WorkItemDispatchConfigWire | null }>).dispatchConfig
  return carried ?? null
}

/** Writes `{ autoStart }` and nothing else, so the engine, model and skills a
 *  Todo already pins are left exactly as they were. */
export async function setTodoAutoStart(id: string, autoStart: boolean): Promise<WorkItemDispatchConfigWire> {
  const res = await authFetch(`/api/work-items/${encodeURIComponent(id)}/dispatch-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoStart }),
  })
  if (!res.ok) {
    let message = `API error: ${res.status}`
    try { message = String((await res.json()).error ?? message) } catch { /* not JSON */ }
    throw new ApiError(res.status, message)
  }
  return ((await res.json()) as { dispatchConfig: WorkItemDispatchConfigWire }).dispatchConfig
}
