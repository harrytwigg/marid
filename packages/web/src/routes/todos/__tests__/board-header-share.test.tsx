import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import type { DepartmentSummaryWire } from "@/lib/api"
import type { BoardId } from "../board/board-route"

let auth: { authState: { accountsEnabled?: boolean }; principal: { kind: string } | null } | null = null
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => auth }))
vi.mock("@/components/people/share-board-button", () => ({
  ShareBoardButton: ({ department, mode, onLeft }: { department: string; mode: string; onLeft?: () => void }) =>
    <button data-testid="board-share" onClick={onLeft}>{department}:{mode}</button>,
}))
vi.mock("@/hooks/use-principal", async (importActual) => {
  const actual = await importActual<typeof import("@/hooks/use-principal")>()
  return {
    ...actual,
    useMember: () => (auth?.principal?.kind === "member" ? { user: { id: "usr_me", email: "me@example.test", displayName: "Me" }, boards: [{ department: "design", role: "owner" }] } : null),
    useBoardAbilities: () => (auth?.principal?.kind === "member" ? actual.abilitiesFor("owner") : null),
  }
})

import { BoardHeader } from "../board/board-header"

const departments: DepartmentSummaryWire[] = [{ slug: "design", prefix: "DES", createdAt: "2026-01-01", todoCount: 2 }]

function renderHeader(board: BoardId) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <BoardHeader
          board={board}
          title="Board"
          departments={departments}
          deptPrefix="DES"
          onQuickCapture={() => {}}
          isAttention={board.kind === "attention"}
          attentionCount={0}
          openCount={1}
          blockedTotal={0}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("Share on the board header", () => {
  it("shows Share on a department board when accounts are enabled", () => {
    auth = { authState: { accountsEnabled: true }, principal: { kind: "operator" } }
    renderHeader({ kind: "department", slug: "design" })
    expect(screen.getByTestId("board-share").textContent).toBe("design:operator")
  })

  it("leaves it off when accounts are not enabled, or the gateway does not say", () => {
    for (const authState of [{ accountsEnabled: false }, {}]) {
      auth = { authState, principal: null }
      const { unmount } = renderHeader({ kind: "department", slug: "design" })
      expect(screen.queryByTestId("board-share")).toBeNull()
      unmount()
    }
  })

  it("leaves it off outside a provider", () => {
    auth = null
    renderHeader({ kind: "department", slug: "design" })
    expect(screen.queryByTestId("board-share")).toBeNull()
  })

  it("leaves it off boards that are not a department", () => {
    auth = { authState: { accountsEnabled: true }, principal: { kind: "operator" } }
    for (const board of [{ kind: "everything" }, { kind: "attention" }] as BoardId[]) {
      const { unmount } = renderHeader(board)
      expect(screen.queryByTestId("board-share")).toBeNull()
      unmount()
    }
  })
})

describe("Share for a board owner in the member shell", () => {
  it("leaves the board's page for the member's home when they take themselves off it", () => {
    auth = { authState: { accountsEnabled: true }, principal: { kind: "member" } }
    const header = (
      <BoardHeader
        board={{ kind: "department", slug: "design" }}
        title="Board"
        departments={departments}
        deptPrefix="DES"
        onQuickCapture={() => {}}
        isAttention={false}
        attentionCount={0}
        openCount={1}
        blockedTotal={0}
      />
    )
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/todos/design"]}>
          <Routes>
            <Route path="/" element={<p data-testid="member-home">home</p>} />
            <Route path="/todos/:board" element={header} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByTestId("board-share").textContent).toBe("design:member")
    fireEvent.click(screen.getByTestId("board-share"))
    expect(screen.getByTestId("member-home")).toBeTruthy()
  })
})
