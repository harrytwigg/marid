import { lazy, Suspense } from "react"
import type { ChainFlowInput } from "./chain-flow-model"

export type { ChainFlowInput } from "./chain-flow-model"

/* @xyflow/react and dagre are most of what this view weighs, and the Settings page
 * and the employee editor mostly never open it: load them when a diagram first
 * shows, as the org map does. */
const Graph = lazy(() => import("./chain-flow-graph"))

/**
 * A fallback chain as a flow diagram: the own target, then each link, joined by
 * "on limit" edges, with each target's health, usage and reset. `position` and
 * `servedBy` mark where a session is and what served it last; a link that would be
 * passed over is dimmed with its reason. Exported for the composer's limits readout.
 */
export function ChainFlow(props: ChainFlowInput) {
  return (
    <Suspense fallback={<div aria-hidden style={{ height: 96 }} />}>
      <Graph {...props} />
    </Suspense>
  )
}
