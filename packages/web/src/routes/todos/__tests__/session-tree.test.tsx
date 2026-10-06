import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import type { Employee } from "@/lib/api"
import type { SessionDirectoryEntryWire, SessionTreeNodeWire, SessionTreeWire } from "@/lib/session-tree-api"
import { SessionRef, SessionDirectoryProvider } from "../task-page/session-ref"
import { answerCaption, pendingWork } from "@/components/chat/pending-work"
import { SessionTreePanel } from "../task-page/session-tree"
import { hasLiveWorker, isLiveSession, pickRailSession } from "../task-page/use-todo-sessions"

/* The Todo page used to dead-end: `createdBy` printed as `session:<uuid>`, the
 * audit line said "A session", and only a live todo-dispatcher was clickable.
 * These cover the two halves of the fix — a session reference you can open, and
 * the tree of work hanging off the Todo. */

const navigate = vi.fn()
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom")
  return { ...actual, useNavigate: () => navigate }
})

const byName = new Map<string, Employee>([
  ["senior-developer", { name: "senior-developer", displayName: "Senior Developer" } as Employee],
])

function entry(over: Partial<SessionDirectoryEntryWire> & { id: string }): SessionDirectoryEntryWire {
  return { employee: null, status: "idle", title: null, archived: false, missing: false, ...over }
}

function node(over: Partial<SessionTreeNodeWire> & { id: string }): SessionTreeNodeWire {
  return {
    employee: null,
    status: "idle",
    title: null,
    role: "execute",
    workItemId: "TST-81",
    isRootLink: true,
    archived: false,
    backgroundActivity: null,
    delegatedActivity: null,
    truncated: null,
    children: [],
    ...over,
  }
}

function tree(over: Partial<SessionTreeWire> = {}): SessionTreeWire {
  return {
    roots: [],
    directory: {},
    truncated: { depth: false, count: false },
    totals: { nodes: 0, live: 0 },
    ...over,
  }
}

function mount(ui: React.ReactNode, directory: Record<string, SessionDirectoryEntryWire> = {}) {
  return render(
    <MemoryRouter>
      <SessionDirectoryProvider directory={directory}>{ui}</SessionDirectoryProvider>
    </MemoryRouter>,
  )
}

describe("a session reference", () => {
  it("names the employee instead of the raw id, and opens the session", () => {
    navigate.mockClear()
    mount(<SessionRef sessionId="s-1" byName={byName} />, {
      "s-1": entry({ id: "s-1", employee: "senior-developer", status: "running" }),
    })

    const ref = screen.getByTestId("session-ref-s-1")
    expect(ref.textContent).toContain("Senior Developer")
    expect(ref.textContent).not.toContain("s-1")

    fireEvent.click(ref)
    expect(navigate).toHaveBeenCalledWith("/?session=s-1")
  })

  it("falls back to a short id rather than printing session:<uuid>", () => {
    mount(<SessionRef sessionId="15279347-a990-4e8a" byName={byName} />)

    const ref = screen.getByTestId("session-ref-15279347-a990-4e8a")
    expect(ref.textContent).toContain("Session 15279347")
    expect(ref.textContent).not.toContain("session:")
  })

  it("does not offer a link to a session that no longer exists", () => {
    mount(<SessionRef sessionId="gone" byName={byName} />, { gone: entry({ id: "gone", missing: true }) })

    expect(screen.queryByTestId("session-ref-gone")).toBeNull()
    expect(screen.getByTestId("session-ref-missing-gone")).toBeTruthy()
  })
})

describe("the session tree", () => {
  it("renders nothing for a Todo no session has worked", () => {
    mount(<SessionTreePanel tree={tree()} byName={byName} todoId="TST-81" />)
    expect(screen.queryByTestId("session-tree")).toBeNull()
  })

  it("keeps a delegated session beneath its parent rather than flattening it", () => {
    const grandchild = node({ id: "s-3", workItemId: null, isRootLink: false })
    const child = node({ id: "s-2", workItemId: "TST-83", isRootLink: false, children: [grandchild] })
    mount(
      <SessionTreePanel tree={tree({ roots: [node({ id: "s-1", children: [child] })] })} byName={byName} todoId="TST-81" />,
      {},
    )

    const parent = screen.getByTestId("session-tree-node-s-2")
    const deep = screen.getByTestId("session-tree-node-s-3")
    // Depth is carried by the indent, so the grandchild must be further in.
    expect(parseInt(deep.style.paddingLeft, 10)).toBeGreaterThan(parseInt(parent.style.paddingLeft, 10))
  })

  it("offers the Todo a node minted, and only when it is not the one being read", () => {
    navigate.mockClear()
    const child = node({ id: "s-2", workItemId: "TST-83", isRootLink: false })
    mount(<SessionTreePanel tree={tree({ roots: [node({ id: "s-1", children: [child] })] })} byName={byName} todoId="TST-81" />)

    expect(screen.queryByTestId("session-tree-todo-s-1")).toBeNull()
    fireEvent.click(screen.getByTestId("session-tree-todo-s-2"))
    expect(navigate).toHaveBeenCalledWith("/todos/TST-83")
  })

  it("marks a review hand-off apart from an execution attempt", () => {
    const reviewer = node({ id: "s-2", role: "review", isRootLink: true })
    mount(<SessionTreePanel tree={tree({ roots: [node({ id: "s-1" }), reviewer] })} byName={byName} todoId="TST-81" />)

    expect(screen.getByTestId("session-tree-node-s-2").getAttribute("data-role")).toBe("review")
    expect(screen.getByTestId("session-tree-review-s-2")).toBeTruthy()
    expect(screen.queryByTestId("session-tree-review-s-1")).toBeNull()
  })

  it("marks a session a mention started as consulted, not executing", () => {
    const consulted = node({ id: "s-2", role: "consult", isRootLink: true })
    mount(<SessionTreePanel tree={tree({ roots: [node({ id: "s-1" }), consulted] })} byName={byName} todoId="TST-81" />)

    expect(screen.getByTestId("session-tree-consult-s-2").textContent).toContain("Consulted")
    expect(screen.queryByTestId("session-tree-review-s-2")).toBeNull()
    expect(screen.queryByTestId("session-tree-consult-s-1")).toBeNull()
  })

  it("says what a bound withheld instead of showing a short tree silently", () => {
    mount(
      <SessionTreePanel
        tree={tree({ roots: [node({ id: "s-1", truncated: { reason: "depth" } })], truncated: { depth: true, count: false } })}
        byName={byName}
        todoId="TST-81"
      />,
    )

    expect(screen.getByTestId("session-tree-truncated-s-1").textContent).toContain("not shown")
  })

  it("keeps an archived session reachable and marked", () => {
    mount(<SessionTreePanel tree={tree({ roots: [node({ id: "s-1", archived: true })] })} byName={byName} todoId="TST-81" />, {
      "s-1": entry({ id: "s-1", employee: "senior-developer", archived: true }),
    })

    expect(screen.getByTestId("session-tree-node-s-1").textContent).toContain("Archived")
    expect(screen.getByTestId("session-ref-s-1")).toBeTruthy()
  })
})

describe("which session the rail offers", () => {
  const s = (id: string, over: Partial<{ employee: string; status: string; workItemRole: string }> = {}) =>
    ({ id, employee: null, status: "idle", ...over }) as never

  it("prefers the live dispatcher — it is the Todo's durable thread", () => {
    const picked = pickRailSession([s("a", { employee: "qa", status: "running" }), s("b", { employee: "todo-dispatcher", status: "running" })])
    expect(picked?.id).toBe("b")
  })

  it("offers a live non-dispatcher, which used to leave the rail empty", () => {
    const picked = pickRailSession([s("a", { employee: "senior-developer", status: "running" })])
    expect(picked?.id).toBe("a")
    expect(isLiveSession(picked)).toBe(true)
  })

  it("still reaches a finished attempt, but does not call it live", () => {
    const picked = pickRailSession([s("a", { employee: "todo-dispatcher", status: "idle" })])
    expect(picked?.id).toBe("a")
    // Dispatch must stay on offer: a Todo whose only attempt ended still needs it.
    expect(isLiveSession(picked)).toBe(false)
  })

  it("keeps a live consulted session from displacing the executor, so Dispatch stays on offer", () => {
    const sessions = [
      s("consult", { employee: "reviewer", status: "running", workItemRole: "consult" }),
      s("exec", { employee: "builder", status: "idle", workItemRole: "execute" }),
    ]
    const picked = pickRailSession(sessions)
    expect(picked?.id).toBe("exec")
    expect(isLiveSession(picked)).toBe(false)
    // A live consult is not a live worker, so Dispatch is not hidden by it.
    expect(hasLiveWorker(sessions)).toBe(false)
    expect(hasLiveWorker([...sessions, s("exec2", { status: "running", workItemRole: "execute" })])).toBe(true)
  })

  it("offers a consulted session when it is the only kind there is", () => {
    const picked = pickRailSession([s("consult", { employee: "reviewer", status: "idle", workItemRole: "consult" })])
    expect(picked?.id).toBe("consult")
  })

  it("offers nothing for a Todo no session has touched", () => {
    expect(pickRailSession([])).toBeUndefined()
    expect(isLiveSession(undefined)).toBe(false)
  })
})

describe("a finished session that left work running", () => {
  const recent = () => new Date().toISOString()

  it("reads the same words the chat puts under the turn's answer", () => {
    const backgroundActivity = { activeStreams: 0, activeMonitors: 1, lastActivityAt: recent() }
    mount(<SessionTreePanel tree={tree({ roots: [node({ id: "s-1", backgroundActivity })], totals: { nodes: 1, live: 0 } })} byName={byName} todoId="TST-81" />)

    const chat = answerCaption("complete", pendingWork(backgroundActivity, null, Date.now()))
    expect(chat).toBe("Waiting on 1 monitor")
    expect(screen.getByTestId("session-tree-node-s-1").textContent).toContain(chat)
    expect(screen.getByTestId("session-tree-node-s-1").textContent).not.toContain("Finished")
  })

  it("names delegated work the chat counts as pending", () => {
    const delegatedActivity = { activeSessions: 2, employees: ["senior-developer"] }
    mount(<SessionTreePanel tree={tree({ roots: [node({ id: "s-1", delegatedActivity })], totals: { nodes: 1, live: 0 } })} byName={byName} todoId="TST-81" />)

    expect(screen.getByTestId("session-tree-node-s-1").textContent).toContain("Waiting on 2 delegated tasks")
  })

  it("says Finished when nothing it left running can still change its answer", () => {
    mount(<SessionTreePanel tree={tree({ roots: [node({ id: "s-1" })], totals: { nodes: 1, live: 0 } })} byName={byName} todoId="TST-81" />)

    expect(screen.getByTestId("session-tree-node-s-1").textContent).toContain("Finished")
  })

  it("keeps Working and Error ahead of any pending-work caption", () => {
    const backgroundActivity = { activeStreams: 0, activeMonitors: 1, lastActivityAt: recent() }
    mount(<SessionTreePanel tree={tree({ roots: [node({ id: "s-1", status: "running", backgroundActivity }), node({ id: "s-2", status: "error", backgroundActivity })], totals: { nodes: 2, live: 1 } })} byName={byName} todoId="TST-81" />)

    expect(screen.getByTestId("session-tree-node-s-1").textContent).toContain("Working")
    expect(screen.getByTestId("session-tree-node-s-2").textContent).toContain("Error")
  })
})

describe("the session tree's department badge", () => {
  it("badges a session bound to a department, at any depth, and no other", () => {
    const child = node({ id: "s-2", isRootLink: false, scopeDepartment: "side-project" })
    mount(<SessionTreePanel tree={tree({ roots: [node({ id: "s-1", children: [child] })] })} byName={byName} todoId="TST-81" />)

    const badges = screen.getAllByTestId("session-department-badge")
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toBe("side-project")
    expect(screen.getByTestId("session-tree-node-s-2").contains(badges[0])).toBe(true)
  })
})
