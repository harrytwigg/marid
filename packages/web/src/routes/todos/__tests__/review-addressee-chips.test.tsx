import { render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Employee, WorkItemCompactWire, WorkItemDetailWire, WorkItemTreeNodeWire, WorkItemTreeWire } from "@/lib/api"
import { deriveNeedsYou } from "@/lib/todos"
import { BoardCard } from "../board/card"
import { ChipCluster } from "../task-page/chip-cluster"

/* A child in review that waits on the employee owning its parent: a "for <name>"
 * chip where it is shown, and no place in the operator's Needs-you list or its count. */

vi.mock("@/components/ui/employee-avatar", () => ({
  EmployeeAvatar: ({ name }: { name: string }) => <span data-testid={`avatar-${name}`} />,
}))

const byName = new Map<string, Employee>([["owner-dev", { name: "owner-dev", displayName: "Owner Dev" } as Employee]])

function row(over: Partial<WorkItemCompactWire> & { id: string }): WorkItemCompactWire {
  return {
    version: 1, title: `Item ${over.id}`, status: "in_review", assignee: null, department: "platform", source: "human", sourceRef: null,
    updatedAt: "2026-08-21T08:00:00.000Z", ...over,
  }
}

function node(over: Partial<WorkItemTreeNodeWire> & { id: string }): WorkItemTreeNodeWire {
  return {
    version: 1, title: `Child ${over.id}`, body: null, status: "backlog", department: "platform", assignee: null, priority: 2, rank: null,
    source: "human", sourceRef: null, rounds: 0, budgetUsd: null, createdAt: "2026-08-21T08:00:00.000Z", updatedAt: "2026-08-21T08:00:00.000Z",
    closedAt: null, children: [], ...over,
  }
}

function treeOf(children: WorkItemTreeNodeWire[]): WorkItemTreeWire {
  return { root: node({ id: "TSK-1", status: "executing", children }), totals: { executing: 1 }, spendUsd: 0 }
}

describe("the card tree tray", () => {
  it("chips a child in review addressed to an employee, and no other row", () => {
    const tree = treeOf([
      node({ id: "TSK-2", status: "in_review", reviewAddressee: { kind: "employee", employee: "owner-dev" } }),
      node({ id: "TSK-3", status: "in_review", reviewAddressee: { kind: "operator" } }),
      node({ id: "TSK-4", status: "executing", reviewAddressee: { kind: "employee", employee: "owner-dev" } }),
      node({ id: "TSK-5", status: "in_review" }),
    ])
    render(
      <BoardCard
        item={row({ id: "TSK-1", status: "executing" })}
        enrichment={{ tree }}
        byName={byName}
        expanded
        onToggleTree={() => {}}
        onOpen={() => {}}
        onOpenChild={() => {}}
        onAddSubTask={() => {}}
      />,
    )
    expect(within(screen.getByTestId("tree-row-TSK-2")).getByTestId("review-for-chip").textContent).toBe("for Owner Dev")
    for (const id of ["TSK-3", "TSK-4", "TSK-5"]) expect(within(screen.getByTestId(`tree-row-${id}`)).queryByTestId("review-for-chip")).toBeNull()
  })
})

describe("the task page's status chip", () => {
  const detail = (status: "in_review" | "executing", reviewAddressee?: WorkItemDetailWire["reviewAddressee"]) =>
    ({ workItem: node({ id: "TSK-2", status }), spendUsd: 0, events: [], reviewAddressee }) as WorkItemDetailWire
  const renderChip = (d: WorkItemDetailWire) =>
    render(<ChipCluster detail={d} byName={byName} rowFor={() => undefined} mobile={false} />)

  it("says who an employee-addressed review is for", () => {
    renderChip(detail("in_review", { kind: "employee", employee: "owner-dev" }))
    expect(screen.getByTestId("chip-status").textContent).toContain("In review")
    expect(within(screen.getByTestId("chip-status")).getByTestId("review-for-chip").textContent).toBe("for Owner Dev")
  })

  it("says nothing for the operator's review, or a Todo that is not in review", () => {
    renderChip(detail("in_review", { kind: "operator" }))
    expect(screen.queryByTestId("review-for-chip")).toBeNull()
    renderChip(detail("executing", { kind: "employee", employee: "owner-dev" }))
    expect(screen.queryByTestId("review-for-chip")).toBeNull()
  })
})

describe("the operator's Needs-you list", () => {
  it("leaves out an employee-addressed review even on the manager lane, and keeps every other row", () => {
    const set = deriveNeedsYou([
      row({ id: "for-employee", attentionLane: "manager", reviewAddressee: { kind: "employee", employee: "owner-dev" } } as never),
      row({ id: "for-operator", attentionLane: "manager", reviewAddressee: { kind: "operator" } } as never),
      row({ id: "stalled-parent", status: "executing", attentionLane: "manager" } as never),
      row({ id: "blocked", status: "blocked" }),
    ])
    expect(set.map((item) => item.id)).toEqual(["for-operator", "stalled-parent", "blocked"])
  })
})
