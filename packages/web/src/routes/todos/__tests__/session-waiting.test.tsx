import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import type { Employee } from "@/lib/api"
import type { SessionDirectoryEntryWire, SessionTreeNodeWire, SessionTreeWire } from "@/lib/session-tree-api"
import { SessionRef, SessionDirectoryProvider } from "../task-page/session-ref"
import { SessionTreePanel } from "../task-page/session-tree"

/* A session in the `waiting` status is paused: on an engine usage limit, or while a
 * remote host comes up. The Todo page used to paint it as a running (blue, pulsing)
 * session. These cover the surfaces that could say that — the reference dot, the tree
 * row and the tree's footer — so the pause never reads as progress. The colour and
 * wording come from lib/session-waiting, so nothing here restates them. */

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

describe("a waiting session on the Todo page", () => {
  it("paints the reference dot amber and still, not blue and pulsing", () => {
    mount(<SessionRef sessionId="s-1" byName={byName} />, {
      "s-1": entry({ id: "s-1", employee: "senior-developer", status: "waiting" }),
    })

    const dot = screen.getByLabelText("Waiting")
    expect(dot.getAttribute("style")).toContain("var(--system-yellow)")
    expect(dot.className).not.toContain("animate-")
  })

  it("keeps a running reference dot pulsing blue and labelled Working", () => {
    mount(<SessionRef sessionId="s-1" byName={byName} />, {
      "s-1": entry({ id: "s-1", employee: "senior-developer", status: "running" }),
    })

    const dot = screen.getByLabelText("Working")
    expect(dot.getAttribute("style")).toBeNull()
    expect(dot.className).toContain("animate-[jinn-pulse")
  })

  it("reads a paused node as Waiting while a running one still reads Working", () => {
    mount(
      <SessionTreePanel
        tree={tree({ roots: [node({ id: "s-1", status: "waiting" }), node({ id: "s-2", status: "running" })] })}
        byName={byName}
        todoId="TST-81"
      />,
    )

    const paused = screen.getByTestId("session-tree-node-s-1").textContent
    expect(paused).toContain("Waiting")
    expect(paused).not.toContain("Working")
    expect(screen.getByTestId("session-tree-node-s-2").textContent).toContain("Working")
  })

  it("does not call a paused session working in the tree's footer", () => {
    mount(
      <SessionTreePanel
        tree={tree({
          roots: [node({ id: "s-1", status: "waiting" }), node({ id: "s-2", status: "idle" })],
          totals: { nodes: 2, live: 1 },
        })}
        byName={byName}
        todoId="TST-81"
      />,
    )

    const footer = screen.getByTestId("session-tree-totals").textContent
    expect(footer).toContain("2 sessions")
    expect(footer).not.toContain("working")
  })

  it("still counts a running session as working in the tree's footer", () => {
    mount(
      <SessionTreePanel
        tree={tree({
          roots: [node({ id: "s-1", status: "running" }), node({ id: "s-2", status: "idle" })],
          totals: { nodes: 2, live: 1 },
        })}
        byName={byName}
        todoId="TST-81"
      />,
    )

    expect(screen.getByTestId("session-tree-totals").textContent).toContain("· 1 working")
  })
})
