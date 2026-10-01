// Todos v2 slice 6 — the ONE client-side legality map (design-doc §5, §7.3).
// Mirrors packages/jinn/src/work-items/transitions.ts for a MANUAL move made on
// the operator (human) surface: board drag, the status pickers, and keyboard
// moves all consume this module — never their own edge lists. The data lives in
// transition-edges.json; the gateway parity test
// (packages/jinn/src/work-items/__tests__/board-legality-parity.test.ts) probes
// the real transition() against that file, so drift fails a build, not a user.
//
// The UI pre-checks; the server stays the authority. A runtime refusal (version
// conflict, a child created mid-drag) still snaps back with the gateway's words.

import edgesFixture from "./transition-edges.json"
import type { WorkItemStatusWire, WorkItemTreeNodeWire } from "./api"

interface EdgesFixture {
  edges: Record<WorkItemStatusWire, WorkItemStatusWire[]>
  manualExecutingFrom: WorkItemStatusWire[]
  sticky: WorkItemStatusWire[]
  closeGated: WorkItemStatusWire[]
}

const FIXTURE = edgesFixture as unknown as EdgesFixture
const MANUAL_EXECUTING_FROM = new Set(FIXTURE.manualExecutingFrom)
const CLOSE_GATED = new Set(FIXTURE.closeGated)

/** One offered target. `gated` = the edge exists but a pre-checked server gate
 *  would refuse it right now — render disabled at 50% with the reason inline
 *  (never hide it: gated ≠ illegal, the design's "living proof" rule). */
export interface LegalTargetOption {
  status: WorkItemStatusWire
  gated: boolean
  reason?: string
  /** Taking this target also closes the item's open descendants, so the commit
   *  must send `cascade: true` — without it the gateway refuses the same move. */
  cascade?: boolean
}

export interface LegalTargetsContext {
  /** Count of this item's children not yet done/cancelled (from the card's own
   *  roll-up counts — the pre-check for the close gate). */
  openChildren?: number
  /** Open items at every depth below this one — what a cascade close actually
   *  closes. A surface that knows only its direct children leaves it out. */
  openDescendants?: number
}

/** The counts read off a loaded tree node, for the surfaces that hold one. */
export interface CloseGateCounts {
  openChildren: number
  openDescendants: number
}

const isOpen = (node: WorkItemTreeNodeWire) => node.status !== "done" && node.status !== "cancelled"

/** The close gate's pre-check, off the tree a surface already loaded. Children
 *  and descendants are different numbers and the gate needs both: the server
 *  weighs the direct children, a cascade closes everything under them. */
export function closeGateCounts(node: WorkItemTreeNodeWire | undefined): CloseGateCounts {
  const children = node?.children ?? []
  let openDescendants = 0
  for (const child of children) {
    const below = closeGateCounts(child)
    if (isOpen(child)) openDescendants += 1
    openDescendants += below.openDescendants
  }
  return { openChildren: children.filter(isOpen).length, openDescendants }
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** The close targets when children are still open. Done is one cascade close
 *  (PLA-96): the gateway takes the open subtree deepest-first in the same
 *  transaction, so the row stays live and says what else it closes. Cancel has
 *  no such lane. */
function closeTarget(to: WorkItemStatusWire, ctx: LegalTargetsContext): LegalTargetOption {
  const openChildren = ctx.openChildren ?? 0
  if (to !== "done") return { status: to, gated: true, reason: `${plural(openChildren, "sub-task")} still open` }
  return {
    status: to,
    gated: false,
    cascade: true,
    reason: `also closes ${plural(ctx.openDescendants ?? openChildren, "open sub-task")}`,
  }
}

/** Legal manual-move targets from `from` on the operator surface, in the
 *  gateway's declared edge order. Illegal edges are ABSENT (never disabled);
 *  gated edges are present with `gated: true` + the reason; a Done over open
 *  sub-tasks is live and carries `cascade`. */
export function legalTargets(
  from: WorkItemStatusWire,
  ctx: LegalTargetsContext = {},
): LegalTargetOption[] {
  const openChildren = ctx.openChildren ?? 0
  const out: LegalTargetOption[] = []
  for (const to of FIXTURE.edges[from] ?? []) {
    // Manual-start rule: a human move INTO executing is legal only from
    // backlog. From in_review, send back is a review verdict on the
    // item (bounce, rounds++), never a drag; from blocked, work
    // resumes through reassignment. Illegal ≠ gated: the edge is absent.
    if (to === "executing" && !MANUAL_EXECUTING_FROM.has(from)) continue
    out.push(CLOSE_GATED.has(to) && openChildren > 0 ? closeTarget(to, ctx) : { status: to, gated: false })
  }
  return out
}

/** Drag convenience: a column is a live drop target only when the edge is
 *  legal AND ungated (a gated column dims like an illegal one — §5). A cascade
 *  target dims with them: dropping a card says nothing about closing the
 *  sub-tasks under it, and a drag is not where that gets decided. */
export function canDropOn(
  from: WorkItemStatusWire,
  to: WorkItemStatusWire,
  ctx: LegalTargetsContext = {},
): boolean {
  return legalTargets(from, ctx).some((t) => t.status === to && !t.gated && !t.cascade)
}
