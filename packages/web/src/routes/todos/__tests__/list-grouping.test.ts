import { describe, expect, it } from "vitest"
import type { WorkItemCompactWire, WorkItemStatusWire } from "@/lib/api"
import { deriveNeedsYou } from "@/lib/todos"
import { groupTodoListItems } from "../list/group-items"

function item(id: string, status: WorkItemStatusWire): WorkItemCompactWire {
  return {
    id,
    version: 1,
    title: `Item ${id}`,
    status,
    assignee: null,
    department: null,
    source: "human",
    sourceRef: null,
    createdBy: "operator",
    parentId: null,
    rootId: id,
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: status === "blocked",
    updatedAt: "2026-07-31T08:00:00.000Z",
    rank: null,
  }
}

describe("groupTodoListItems", () => {
  it("splits recovering and manager lanes out of Needs you", () => {
    const recovering = { ...item("PLA-1", "blocked"), attentionLane: "recovering" as const }
    const manager = { ...item("PLA-2", "blocked"), attentionLane: "manager" as const }
    const operator = { ...item("PLA-3", "blocked"), attentionLane: "operator" as const }
    const empty = { items: [], total: 0 }
    const groups = groupTodoListItems(
      {
        backlog: empty, executing: empty, in_review: empty,
        blocked: { items: [recovering, manager, operator], total: 3 },
        done: empty, cancelled: empty,
      },
      [recovering, manager, operator],
    )
    expect(groups.find((group) => group.key === "recovering")?.items.map(({ id }) => id)).toEqual(["PLA-1"])
    expect(groups.find((group) => group.key === "manager")?.items.map(({ id }) => id)).toEqual(["PLA-2"])
    expect(groups.find((group) => group.key === "needs-you")?.items.map(({ id }) => id)).toEqual(["PLA-3"])
  })

  it("an in_review leftover with attentionLane manager reaches Manager attention, not Needs you", () => {
    const leftover = {
      ...item("QPR-4", "in_review"),
      attentionLane: "manager" as const,
      assignee: "platform-worker",
    }
    const operatorGate = { ...item("QAP-10", "blocked"), attentionLane: "operator" as const }
    const empty = { items: [], total: 0 }
    const feed = deriveNeedsYou([leftover, operatorGate])
    const groups = groupTodoListItems(
      {
        backlog: empty, executing: empty,
        in_review: { items: [leftover], total: 1 },
        blocked: { items: [operatorGate], total: 1 },
        done: empty, cancelled: empty,
      },
      feed,
    )
    expect(groups.find((group) => group.key === "manager")?.items.map(({ id }) => id)).toEqual(["QPR-4"])
    expect(groups.find((group) => group.key === "needs-you")?.items.map(({ id }) => id)).toEqual(["QAP-10"])
    expect(groups.find((group) => group.key === "in-review")?.items.map(({ id }) => id)).not.toContain("QPR-4")
  })

  it("a recovering API row reaches Recovering automatically and not Needs you", () => {
    const recovering = { ...item("QAP-2", "blocked"), attentionLane: "recovering" as const, assignee: "platform-worker" }
    const operatorGate = { ...item("QAP-10", "blocked"), attentionLane: "operator" as const }
    const empty = { items: [], total: 0 }
    const feed = deriveNeedsYou([recovering, operatorGate])
    const groups = groupTodoListItems(
      {
        backlog: empty, executing: empty,
        in_review: empty,
        blocked: { items: [recovering, operatorGate], total: 2 },
        done: empty, cancelled: empty,
      },
      feed,
    )
    expect(groups.find((group) => group.key === "recovering")?.items.map(({ id }) => id)).toEqual(["QAP-2"])
    expect(groups.find((group) => group.key === "needs-you")?.items.map(({ id }) => id)).toEqual(["QAP-10"])
  })

  it("hoists an attention item outside the loaded status page", () => {
    const needsReview = item("PLA-21", "in_review")
    const groups = groupTodoListItems(
      {
        backlog: { items: [], total: 0 },
        executing: { items: [], total: 0 },
        in_review: { items: [], total: 21 },
        blocked: { items: [], total: 0 },
        done: { items: [], total: 0 },
        cancelled: { items: [], total: 0 },
      },
      [needsReview],
    )

    expect(groups.find((group) => group.key === "needs-you")?.items.map(({ id }) => id)).toEqual(["PLA-21"])
    expect(groups.find((group) => group.key === "in-review")?.items).toEqual([])
    expect(groups.find((group) => group.key === "in-review")?.count).toBe(20)
    expect(groups.flatMap((group) => group.items).filter(({ id }) => id === "PLA-21")).toHaveLength(1)
  })

  it("hoists attention items exactly once and keeps an ordinary blocked item in Blocked", () => {
    const needsReview = item("ICI-1", "in_review")
    const needsBlocked = item("ICI-2", "blocked")
    const ordinaryBlocked = item("ICI-3", "blocked")
    const groups = groupTodoListItems(
      {
        backlog: { items: [], total: 0 },
        executing: { items: [], total: 0 },
        in_review: { items: [needsReview], total: 1 },
        blocked: { items: [needsBlocked, ordinaryBlocked], total: 2 },
        done: { items: [], total: 0 },
        cancelled: { items: [], total: 0 },
      },
      [needsReview, needsBlocked],
    )

    expect(groups.map((group) => group.key)).toEqual([
      "needs-you",
      "executing",
      "in-review",
      "backlog",
      "blocked",
      "closed",
    ])
    expect(groups.find((group) => group.key === "needs-you")?.items.map(({ id }) => id)).toEqual([
      "ICI-1",
      "ICI-2",
    ])
    expect(groups.find((group) => group.key === "in-review")?.items).toEqual([])
    expect(groups.find((group) => group.key === "blocked")?.items.map(({ id }) => id)).toEqual(["ICI-3"])
    expect(groups.flatMap((group) => group.items).filter(({ id }) => id === "ICI-1")).toHaveLength(1)
    expect(groups.flatMap((group) => group.items).filter(({ id }) => id === "ICI-2")).toHaveLength(1)
  })

  it("omits the groups a one-status view never queried, rather than showing them as 0", () => {
    const executing = item("ICI-9", "executing")
    const empty = { items: [], total: 0 }
    const groups = groupTodoListItems(
      {
        backlog: empty, executing: { items: [executing], total: 1 },
        in_review: empty, blocked: empty, done: empty, cancelled: empty,
      },
      [],
      (status) => status === "executing",
    )

    // "Backlog 0" would assert something nobody asked the gateway — the backlog
    // column is disabled on this URL, so its row is absent, not zeroed.
    expect(groups.map((group) => group.key)).toEqual(["needs-you", "executing"])
    expect(groups.find((group) => group.key === "executing")?.count).toBe(1)
  })
})
