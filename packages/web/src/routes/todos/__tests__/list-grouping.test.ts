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
  it("splits only the recovering lane out of Blocked and leaves manager and operator lane items in it", () => {
    const recovering = { ...item("TSK-1", "blocked"), attentionLane: "recovering" as const }
    const manager = { ...item("TSK-2", "blocked"), attentionLane: "manager" as const }
    const operator = { ...item("TSK-3", "blocked"), attentionLane: "operator" as const }
    const empty = { items: [], total: 0 }
    const groups = groupTodoListItems(
      {
        backlog: empty, executing: empty, in_review: empty,
        blocked: { items: [recovering, manager, operator], total: 3 },
        done: empty, cancelled: empty,
      },
      [recovering, manager, operator],
    )
    expect(groups.find((group) => group.key === "recovering")?.items.map(({ id }) => id)).toEqual(["TSK-1"])
    expect(groups.map((group) => group.key)).not.toContain("manager")
    const blocked = groups.find((group) => group.key === "blocked")
    expect(blocked?.items.map(({ id }) => id)).toEqual(["TSK-2", "TSK-3"])
    expect(blocked?.count).toBe(2)
    expect(groups.map((group) => group.key)).not.toContain("needs-you")
  })

  it("an in_review leftover with attentionLane manager stays under In review, and the operator gate stays in Blocked", () => {
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
    expect(groups.map((group) => group.key)).not.toContain("manager")
    expect(groups.find((group) => group.key === "blocked")?.items.map(({ id }) => id)).toEqual(["QAP-10"])
    const inReview = groups.find((group) => group.key === "in-review")
    expect(inReview?.items.map(({ id }) => id)).toEqual(["QPR-4"])
    expect(inReview?.count).toBe(1)
  })

  it("a recovering API row reaches Recovering automatically and the operator gate stays in Blocked", () => {
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
    expect(groups.find((group) => group.key === "blocked")?.items.map(({ id }) => id)).toEqual(["QAP-10"])
  })

  it("keeps an unloaded manager-lane item in its status count rather than a separate group", () => {
    const needsReview = { ...item("TSK-22", "in_review"), attentionLane: "manager" as const }
    const empty = { items: [], total: 0 }
    const groups = groupTodoListItems(
      { backlog: empty, executing: empty, in_review: { items: [], total: 21 }, blocked: empty, done: empty, cancelled: empty },
      [needsReview],
    )
    expect(groups.map((group) => group.key)).not.toContain("manager")
    expect(groups.find((group) => group.key === "in-review")?.count).toBe(21)
  })

  it("hoists a recovering item outside the loaded status page", () => {
    const needsReview = { ...item("TSK-21", "in_review"), attentionLane: "recovering" as const }
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

    expect(groups.find((group) => group.key === "recovering")?.items.map(({ id }) => id)).toEqual(["TSK-21"])
    expect(groups.find((group) => group.key === "in-review")?.items).toEqual([])
    expect(groups.find((group) => group.key === "in-review")?.count).toBe(20)
    expect(groups.flatMap((group) => group.items).filter(({ id }) => id === "TSK-21")).toHaveLength(1)
  })

  it("shows every blocked Todo under Blocked, whoever it is waiting on", () => {
    const operatorBlocked = { ...item("ISS-2", "blocked"), attentionLane: "operator" as const, assignee: "operator" }
    const unassignedBlocked = item("ISS-3", "blocked")
    const groups = groupTodoListItems(
      {
        backlog: { items: [], total: 0 },
        executing: { items: [], total: 0 },
        in_review: { items: [], total: 0 },
        blocked: { items: [operatorBlocked, unassignedBlocked], total: 2 },
        done: { items: [], total: 0 },
        cancelled: { items: [], total: 0 },
      },
      [operatorBlocked],
    )

    expect(groups.map((group) => group.key)).toEqual(["executing", "in-review", "backlog", "blocked", "closed"])
    expect(groups.find((group) => group.key === "blocked")?.items.map(({ id }) => id)).toEqual(["ISS-2", "ISS-3"])
    expect(groups.find((group) => group.key === "blocked")?.count).toBe(2)
  })

  it("leaves an operator-lane in_review Todo in its own status group", () => {
    const awaitingOperator = { ...item("ISS-5", "in_review"), attentionLane: "operator" as const }
    const empty = { items: [], total: 0 }
    const groups = groupTodoListItems(
      {
        backlog: empty, executing: empty,
        in_review: { items: [awaitingOperator], total: 1 },
        blocked: empty, done: empty, cancelled: empty,
      },
      [awaitingOperator],
    )

    expect(groups.find((group) => group.key === "in-review")?.items.map(({ id }) => id)).toEqual(["ISS-5"])
    expect(groups.find((group) => group.key === "in-review")?.count).toBe(1)
  })

  it("omits the groups a one-status view never queried, rather than showing them as 0", () => {
    const executing = item("ISS-9", "executing")
    const empty = { items: [], total: 0 }
    const groups = groupTodoListItems(
      {
        backlog: empty, executing: { items: [executing], total: 1 },
        in_review: empty, blocked: empty, done: empty, cancelled: empty,
      },
      [],
      (status) => status === "executing",
    )

    // "To do 0" would assert something nobody asked the gateway — the backlog
    // column is disabled on this URL, so its row is absent, not zeroed.
    expect(groups.map((group) => group.key)).toEqual(["executing"])
    expect(groups.find((group) => group.key === "executing")?.count).toBe(1)
  })
})
