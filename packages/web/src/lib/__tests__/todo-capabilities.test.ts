import { describe, expect, it } from "vitest"
import type { WorkItemStatusWire, WorkItemTreeNodeWire } from "../api"
import { OPERATOR_CAPABILITIES, commentPowers, isMemberOnlyTree, memberCapabilities } from "../todo-capabilities"

function node(partial: Partial<WorkItemTreeNodeWire> & { id: string }, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire {
  return {
    title: partial.id, body: null, status: "backlog" as WorkItemStatusWire, department: "platform", assignee: null, priority: 2, rank: null,
    source: "connector", sourceRef: null, rounds: 0, budgetUsd: null, createdBy: "user:abc", createdAt: "", updatedAt: "", closedAt: null,
    ...partial, children,
  }
}

describe("member-only trees", () => {
  it("holds when every Todo is person-made, unassigned and not worked", () => {
    expect(isMemberOnlyTree(node({ id: "A-1" }, [node({ id: "A-2", status: "done" }), node({ id: "A-3" })]))).toBe(true)
  })

  it("fails on one Todo the operator or an employee made, however deep", () => {
    expect(isMemberOnlyTree(node({ id: "A-1" }, [node({ id: "A-2" }, [node({ id: "A-3", createdBy: "operator" })])]))).toBe(false)
    expect(isMemberOnlyTree(node({ id: "A-1", createdBy: "marid-dev" }))).toBe(false)
  })

  it("fails on an assignee anywhere in the tree", () => {
    expect(isMemberOnlyTree(node({ id: "A-1" }, [node({ id: "A-2", assignee: "marid-dev" })]))).toBe(false)
  })

  it("fails once an agent has reached the Todo (a status only agents move it to)", () => {
    for (const status of ["executing", "in_review", "blocked", "cancelled"] as WorkItemStatusWire[]) {
      expect(isMemberOnlyTree(node({ id: "A-1" }, [node({ id: "A-2", status })])), status).toBe(false)
    }
  })

  it("is false with no tree loaded, so nothing is offered before it is known", () => {
    expect(isMemberOnlyTree(undefined)).toBe(false)
  })
})

describe("capabilities", () => {
  it("gives a viewer nothing to write", () => {
    expect(memberCapabilities("viewer", true)).toMatchObject({ comment: false, attach: false, create: false, edit: false, close: false, operatorControls: false })
  })

  it("lets a collaborator comment anywhere but edit, create and close only in a member-only tree", () => {
    expect(memberCapabilities("collaborator", false)).toMatchObject({ comment: true, attach: true, create: false, edit: false, close: false })
    expect(memberCapabilities("collaborator", true)).toMatchObject({ comment: true, create: true, edit: true, close: true })
  })

  it("never hands a member the operator's controls, at any role", () => {
    for (const role of ["viewer", "collaborator", "owner"] as const) {
      expect(memberCapabilities(role, true).operatorControls).toBe(false)
    }
    expect(OPERATOR_CAPABILITIES).toMatchObject({ memberMode: false, operatorControls: true })
  })

  it("lets a member edit and delete only the comments they wrote", () => {
    const caps = memberCapabilities("collaborator", false)
    expect(commentPowers(caps, { author: "user:me", authorKind: "member" }, "me")).toEqual({ reply: true, edit: true, remove: true })
    // Plugins and older builds also write system comments: authorship is the `user:` identity, not the kind.
    expect(commentPowers(caps, { author: "user:me", authorKind: "system" }, "me").edit).toBe(true)
    expect(commentPowers(caps, { author: "user:other", authorKind: "member" }, "me")).toEqual({ reply: true, edit: false, remove: false })
    expect(commentPowers(caps, { author: "operator", authorKind: "operator" }, "me").remove).toBe(false)
  })

  it("lets a viewer do none of it", () => {
    expect(commentPowers(memberCapabilities("viewer", false), { author: "user:me", authorKind: "member" }, "me")).toEqual({ reply: false, edit: false, remove: false })
  })

  it("keeps the operator's comment powers as they were", () => {
    expect(commentPowers(OPERATOR_CAPABILITIES, { author: "operator", authorKind: "operator" }, null)).toEqual({ reply: true, edit: true, remove: true })
    expect(commentPowers(OPERATOR_CAPABILITIES, { author: "marid-dev", authorKind: "employee" }, null)).toEqual({ reply: true, edit: false, remove: true })
  })
})
