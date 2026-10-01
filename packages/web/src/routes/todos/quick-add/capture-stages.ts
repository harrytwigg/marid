import type { TodoCaptureWire } from "@/lib/api"

/**
 * What the operator is told a capture has done, and in what order.
 *
 * `captured` is the client's own fact — it is true the moment the text is
 * submitted, and it is the only stage the browser is entitled to assert. Every
 * other line comes from the server's derived state, so the strip can never show
 * progress the pipeline has not actually made.
 */

export const CAPTURE_STEPS = ["captured", "starting", "shaping", "created", "dispatching", "routed"] as const
export type CaptureStep = (typeof CAPTURE_STEPS)[number]

export function stepIndex(step: CaptureStep): number {
  return CAPTURE_STEPS.indexOf(step)
}

/** The terminal line for a capture that restated a Todo the board already had.
 *  Distinct from `routed` on purpose: it is a different outcome, not a worse
 *  one, and the operator's next question is which Todo — so it says which. */
export function landedLabel(state: TodoCaptureWire | null): string {
  return state?.workItemId ? `Already tracked as ${state.workItemId}` : "Already tracked"
}

/** The line for a stage, given the facts that stage carries. */
export function stepLabel(step: CaptureStep, state: TodoCaptureWire | null): string {
  switch (step) {
    case "captured":
      return "Captured"
    case "starting":
      return "Session starting"
    case "shaping":
      return "Shaping"
    case "created":
      return state?.workItemId ? `${state.workItemId} created` : "Todo created"
    case "dispatching":
      return "Dispatching"
    case "routed":
      return routedLabel(state)
  }
}

function routedLabel(state: TodoCaptureWire | null): string {
  const routed = state?.routedTo
  if (!routed) return "Routed"
  return `Delegated to ${routed.employee}`
}

/**
 * Fold a newly-read server state into the steps already shown.
 *
 * Stages are only ever ADDED, and only up to the one the server currently
 * reports: a capture that jumps straight from `shaping` to `routed` (because
 * the browser was asleep between polls) still shows the intermediate lines it
 * skipped, because those facts did happen — but nothing beyond what the wire
 * has said is ever drawn.
 */
export function foldCaptureSteps(seen: CaptureStep[], state: TodoCaptureWire): CaptureStep[] {
  // Neither terminal adds a rung. `failed` is self-evident; `landed` is the
  // subtler one — a capture that restated an existing Todo never created one,
  // never dispatched one and never routed one, so drawing `created` or anything
  // after it would be claiming three facts that did not happen. The landing is
  // rendered as its own line instead.
  if (state.stage === "failed" || state.stage === "landed") return seen
  const reached = stepIndex(state.stage as CaptureStep)
  if (reached < 0) return seen
  const next = CAPTURE_STEPS.slice(0, reached + 1)
  return next.length > seen.length ? next : seen
}
