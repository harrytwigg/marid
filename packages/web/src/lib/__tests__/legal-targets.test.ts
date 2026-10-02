import { describe, it, expect } from "vitest"
import { legalTargets, canDropOn, closeGateCounts } from "../legal-targets"
import type { WorkItemStatusWire, WorkItemTreeNodeWire } from "../api"

/* Slice 6 — the client legality map. The full matrix is pinned here; the
 * SERVER parity lives in packages/jinn/src/work-items/__tests__/
 * board-legality-parity.test.ts, which probes transition() behaviorally
 * against the same transition-edges.json this module reads. */

const statuses = (targets: ReturnType<typeof legalTargets>) => targets.map((t) => t.status)

describe("legalTargets — manual operator moves, ungated", () => {
  const MATRIX: Record<WorkItemStatusWire, WorkItemStatusWire[]> = {
    // executing reachable only from backlog (manual-start rule).
    backlog: ["executing", "in_review", "blocked", "done", "cancelled"],
    executing: ["backlog", "in_review", "blocked", "done", "cancelled"],
    // Send back is a review verdict, never a manual move: executing absent.
    in_review: ["done", "blocked", "cancelled"],
    // Unblock resumes through backlog; executing absent (manual rule).
    blocked: ["backlog", "in_review", "done", "cancelled"],
    // Sticky terminals exit on the human surface only — which this is.
    done: ["backlog"],
    cancelled: ["backlog"],
  }

  for (const [from, expected] of Object.entries(MATRIX) as [WorkItemStatusWire, WorkItemStatusWire[]][]) {
    it(`from ${from} offers exactly [${expected.join(", ")}]`, () => {
      const targets = legalTargets(from)
      expect(statuses(targets)).toEqual(expected)
      expect(targets.every((t) => !t.gated)).toBe(true)
    })
  }

  it("never offers the current status or an illegal edge", () => {
    for (const from of Object.keys(MATRIX) as WorkItemStatusWire[]) {
      const offered = statuses(legalTargets(from))
      expect(offered).not.toContain(from)
    }
    expect(statuses(legalTargets("in_review"))).not.toContain("backlog")
    expect(statuses(legalTargets("in_review"))).not.toContain("executing")
  })
})

describe("legalTargets — the roll-up close gate", () => {
  it("gates cancelled with the open-children reason", () => {
    const targets = legalTargets("executing", { openChildren: 3 })
    const cancelled = targets.find((t) => t.status === "cancelled")
    expect(cancelled).toEqual({ status: "cancelled", gated: true, reason: "3 sub-tasks still open" })
    // Gated ≠ illegal: the row is PRESENT (pickers render it disabled).
    expect(statuses(targets)).toContain("cancelled")
  })

  it("singular reason for one open child", () => {
    const cancelled = legalTargets("in_review", { openChildren: 1 }).find((t) => t.status === "cancelled")
    expect(cancelled?.reason).toBe("1 sub-task still open")
  })

  it("does not gate non-close targets", () => {
    const targets = legalTargets("executing", { openChildren: 2 })
    expect(targets.find((t) => t.status === "in_review")?.gated).toBe(false)
    expect(targets.find((t) => t.status === "blocked")?.gated).toBe(false)
  })
})

describe("legalTargets — the cascade close (PLA-96)", () => {
  it("offers done live, saying what the one close takes with it", () => {
    const done = legalTargets("in_review", { openChildren: 3 }).find((t) => t.status === "done")
    expect(done).toEqual({ status: "done", gated: false, cascade: true, reason: "also closes 3 open sub-tasks" })
  })

  it("counts every open descendant, not only the direct children", () => {
    const done = legalTargets("in_review", { openChildren: 3, openDescendants: 7 }).find((t) => t.status === "done")
    expect(done).toEqual({ status: "done", gated: false, cascade: true, reason: "also closes 7 open sub-tasks" })
  })

  it("singular when the cascade closes one", () => {
    const done = legalTargets("in_review", { openChildren: 1 }).find((t) => t.status === "done")
    expect(done?.reason).toBe("also closes 1 open sub-task")
  })

  it("never cascades cancelled", () => {
    const cancelled = legalTargets("in_review", { openChildren: 3, openDescendants: 7 }).find((t) => t.status === "cancelled")
    expect(cancelled).toEqual({ status: "cancelled", gated: true, reason: "3 sub-tasks still open" })
  })
})

describe("closeGateCounts — the pre-check read off a loaded tree", () => {
  const node = (status: WorkItemStatusWire, children: unknown[] = []) =>
    ({ status, children }) as unknown as WorkItemTreeNodeWire

  it("keeps direct children apart from the whole open subtree", () => {
    const counts = closeGateCounts(node("executing", [
      node("executing", [node("blocked"), node("done")]),
      node("done"),
      node("backlog"),
    ]))
    expect(counts).toEqual({ openChildren: 2, openDescendants: 3 })
  })

  it("reads a leaf — and a tree that never loaded — as nothing to close", () => {
    const nothing = { openChildren: 0, openDescendants: 0 }
    expect(closeGateCounts(node("executing"))).toEqual(nothing)
    expect(closeGateCounts(undefined)).toEqual(nothing)
  })
})

describe("canDropOn — drag legality", () => {
  it("legal ungated edges are live targets", () => {
    expect(canDropOn("backlog", "executing")).toBe(true)
    expect(canDropOn("done", "backlog")).toBe(true)
  })
  it("illegal edges are not targets", () => {
    expect(canDropOn("in_review", "executing")).toBe(false)
    expect(canDropOn("in_review", "backlog")).toBe(false)
    expect(canDropOn("done", "done")).toBe(false)
  })
  it("a gated column dims like an illegal one", () => {
    expect(canDropOn("executing", "cancelled", { openChildren: 2 })).toBe(false)
    expect(canDropOn("executing", "done", { openChildren: 0 })).toBe(true)
  })
  it("a cascade column dims too — a drag says nothing about closing the children", () => {
    expect(canDropOn("executing", "done", { openChildren: 2 })).toBe(false)
  })
})
