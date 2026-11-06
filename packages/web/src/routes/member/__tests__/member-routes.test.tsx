import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BoardRole } from "@/lib/accounts-api"

type Principal = { kind: "member"; user: { id: string; email: string; displayName: string }; boards: { department: string; role: BoardRole }[] }
let principal: Principal
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => ({ principal, authState: { accountsEnabled: true, principal } }), useAuth: () => ({ principal, logout: vi.fn() }) }))
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
// The board page is a probe; a test can put something on it (the Share dialog, wired as the board header wires it).
const boardSlot = vi.hoisted(() => ({ content: null as null | (() => React.ReactNode) }))
vi.mock("@/routes/todos/board/board-page", () => ({ default: () => <div data-testid="board-probe">{boardSlot.content?.()}</div> }))
vi.mock("@/routes/todos/task-page/task-page", () => ({ default: () => <div data-testid="todo-probe" /> }))

const listMemberBoards = vi.fn()
const getMemberBoardRoster = vi.fn()
const memberRemoveBoardMember = vi.fn()
vi.mock("@/lib/accounts-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accounts-api")>()
  return {
    ...actual,
    accountsApi: {
      ...actual.accountsApi,
      listMemberBoards: (...a: unknown[]) => listMemberBoards(...a),
      getMemberBoardRoster: (...a: unknown[]) => getMemberBoardRoster(...a),
      memberRemoveBoardMember: (...a: unknown[]) => memberRemoveBoardMember(...a),
    },
  }
})

import "@/test/preload-dialogs"
import { MemberRoutes } from "../member-routes"
import { BoardShareDialog } from "@/components/people/board-share-dialog"

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}><MemberRoutes /><Where /></MemoryRouter>
    </QueryClientProvider>,
  )
}

const grant = (department: string, role: BoardRole = "viewer") => ({ department, role })

beforeEach(() => {
  boardSlot.content = null
  principal = { kind: "member", user: { id: "me", email: "me@example.test", displayName: "Mia" }, boards: [grant("platform")] }
  listMemberBoards.mockResolvedValue([{ ...grant("platform"), prefix: "PLT" }, { ...grant("design"), prefix: "DES" }])
})

describe("the member app's routes", () => {
  it("lands a member of one board straight on it", async () => {
    listMemberBoards.mockResolvedValue([{ ...grant("platform"), prefix: "PLT" }])
    renderAt("/")
    expect(await screen.findByTestId("board-probe")).toBeTruthy()
    expect(screen.getByTestId("where").textContent).toBe("/todos/b/platform")
  })

  it("lists the boards of a member of several", async () => {
    renderAt("/")
    expect(await screen.findByTestId("member-home")).toBeTruthy()
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(expect.arrayContaining(["/todos/b/platform", "/todos/b/design"]))
  })

  it("says so, plainly, to a member of none", async () => {
    listMemberBoards.mockResolvedValue([])
    renderAt("/")
    expect(await screen.findByTestId("member-no-boards")).toBeTruthy()
  })

  it("shows a board they hold", async () => {
    renderAt("/todos/b/platform")
    expect(await screen.findByTestId("board-probe")).toBeTruthy()
  })

  it("shows the same not-shared page for a board they lack and the operator's lenses", async () => {
    for (const path of ["/todos/b/secret", "/todos/b/everything", "/todos/b/attention"]) {
      const { unmount } = renderAt(path)
      expect(await screen.findByTestId("board-not-shared"), path).toBeTruthy()
      unmount()
    }
  })

  it("follows a grant made after sign-in: the boards query, not the principal read at load", async () => {
    // The principal still says platform only; the gateway now says design too.
    listMemberBoards.mockResolvedValue([{ ...grant("platform"), prefix: "PLT" }, { ...grant("design"), prefix: "DES" }])
    renderAt("/todos/b/design")
    expect(await screen.findByTestId("board-probe")).toBeTruthy()
  })

  it("follows a revoked grant: a board the principal still lists is not shared once the query drops it", async () => {
    listMemberBoards.mockResolvedValue([{ ...grant("design"), prefix: "DES" }])
    renderAt("/todos/b/platform")
    expect(await screen.findByTestId("board-not-shared")).toBeTruthy()
  })

  it("opens a Todo page", async () => {
    renderAt("/todos/PLT-1")
    expect(await screen.findByTestId("todo-probe")).toBeTruthy()
  })

  it("sends every operator route back to their boards", async () => {
    for (const path of ["/settings", "/org", "/cron", "/talk", "/chat/abc", "/todos"]) {
      const { unmount } = renderAt(path)
      await screen.findByTestId("where")
      await vi.waitFor(() => expect(screen.getByTestId("where").textContent, path).not.toBe(path))
      // Back home, which (with two boards) is the boards list.
      expect(await screen.findByTestId("member-home")).toBeTruthy()
      expect(screen.getByTestId("where").textContent).toBe("/")
      unmount()
    }
  })

  it("takes a member who leaves their only board home, to say they have none, not back to the board", async () => {
    principal = { kind: "member", user: { id: "me", email: "me@example.test", displayName: "Mia" }, boards: [grant("design", "owner")] }
    let boards = [{ ...grant("design", "owner"), prefix: "DES" }]
    // A real read takes a moment: long enough for the home page to render whatever list the cache holds first.
    listMemberBoards.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return boards
    })
    getMemberBoardRoster.mockResolvedValue({
      members: [{ userId: "me", displayName: "Mia", email: "me@example.test", initials: "M", role: "owner" }],
      invites: [],
    })
    // The gateway has taken them off by the time the boards are read again.
    memberRemoveBoardMember.mockImplementation(async () => { boards = [] })
    function ShareOnBoard() {
      const navigate = useNavigate()
      return <BoardShareDialog department="design" mode="member" ownRole="owner" selfUserId="me" open onClose={() => {}} onLeft={() => navigate("/", { replace: true })} />
    }
    boardSlot.content = () => <ShareOnBoard />

    renderAt("/todos/b/design")
    fireEvent.click(await screen.findByRole("button", { name: "Leave Mia" }))
    fireEvent.click(screen.getByRole("button", { name: "Leave" }))

    expect(await screen.findByTestId("member-no-boards")).toBeTruthy()
    expect(screen.getByTestId("where").textContent).toBe("/")
    expect(screen.queryByTestId("board-not-shared")).toBeNull()
  })
})
