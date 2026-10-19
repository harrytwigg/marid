import type { BoardHook, HookActionSummary, HookMatch, HookRunStatus } from "@/lib/api-hooks"
import { isForbidden } from "@/lib/api-hooks"

/** Small shared formatters for the Hooks page: how a hook reads in the list,
 *  and how a run's outcome reads in the log. Pure, so the page's tests can
 *  reach them without a render. */

const MATCH_FIELDS: readonly (keyof HookMatch)[] = ["from", "to", "department", "label", "assignee", "actor"]

function valueLabel(value: string | string[]): string {
  return Array.isArray(value) ? value.join(" or ") : value
}

/** The matcher in one line — `to in_review, label auto-merge` — or `any` when
 *  it is empty and the hook reacts to every event of its configured types. */
export function matchSummary(match: HookMatch): string {
  const parts = MATCH_FIELDS.flatMap((field) => {
    const value = match[field]
    if (value === undefined || (Array.isArray(value) && value.length === 0)) return []
    return [`${field} ${valueLabel(value)}`]
  })
  return parts.length > 0 ? parts.join(", ") : "any"
}

/** The events in one line, counting them once there are more than two. */
export function eventsSummary(events: readonly string[]): string {
  if (events.length === 0) return "no events"
  if (events.length <= 2) return events.join(", ")
  return `${events.length} events`
}

export function actionSummary(action: HookActionSummary): string {
  switch (action.kind) {
    case "spawn":
      return `spawn ${action.employee}`
    case "command":
      return action.run
    case "notify":
      return `notify ${action.connector}:${action.channel}`
  }
}

export function actionsSummary(hook: BoardHook): string {
  return hook.actions.length > 0 ? hook.actions.map(actionSummary).join(" · ") : "no actions"
}

/** The tint the outcome badge carries. A run still going is neutral; a
 *  suppressed fire is a warning, not a failure. */
export function outcomeBadgeVariant(status: HookRunStatus): "success" | "destructive" | "warning" | "secondary" {
  switch (status) {
    case "ok":
      return "success"
    case "error":
      return "destructive"
    case "suppressed":
    case "interrupted":
      return "warning"
    default:
      return "secondary"
  }
}

/** The line under a failed control: a 403 is the API's operator-only rule and
 *  reads as such, everything else is the message the request carried. */
export function describeFailure(cause: unknown, fallback: string): string {
  if (isForbidden(cause)) return "Only the operator can change a hook."
  return cause instanceof Error && cause.message ? cause.message : fallback
}
