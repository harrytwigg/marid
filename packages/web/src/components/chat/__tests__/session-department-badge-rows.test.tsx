import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"

/* The department badge on the chat sidebar's rows: the grouped and flat desktop
 * rows, the tree view, and the phone row. Mocks follow chat-sidebar-list.test.tsx. */

const sidebarData = vi.hoisted(() => ({ sessions: [] as Record<string, unknown>[] }))

vi.mock("@/hooks/use-sessions", () => ({
  useSessions: () => ({ data: sidebarData.sessions, isLoading: false }),
  usePinnedSessions: () => ({ data: [] }),
  useSessionCounts: () => ({ data: { counts: {}, perGroup: 8 } }),
  useSessionSearch: () => ({ data: undefined }),
  useUpdateSession: () => ({ mutate: vi.fn() }),
  useDeleteSession: () => ({ mutateAsync: vi.fn() }),
  useStopSession: () => ({ mutate: vi.fn() }),
  useArchiveSession: () => ({ mutateAsync: vi.fn() }),
  useUnarchiveSession: () => ({ mutateAsync: vi.fn() }),
  useBulkDeleteSessions: () => ({ mutateAsync: vi.fn() }),
  useDuplicateSession: () => ({ mutate: vi.fn() }),
}))
vi.mock("@/hooks/use-pins", () => ({ usePins: () => ({ data: new Set<string>() }), useTogglePin: () => ({ mutate: vi.fn() }) }))
vi.mock("@/lib/api", () => ({ api: { getOrg: () => Promise.resolve({ employees: [] }), getEmployee: () => Promise.resolve({}) } }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { portalName: "Jinn", employeeOverrides: {} } }) }))
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSeparator: () => <hr />,
}))
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}))

import { ChatSidebar } from "../chat-sidebar"
import { MobileSessionRow } from "../mobile-session-row"

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
const session = (extra: Record<string, unknown> = {}) => ({ id: "s-1", title: "Fix the build", employee: "side-dev", source: "web", lastActivity: new Date().toISOString(), ...extra })

function renderSidebar(variant: "desktop" | "mobile" = "desktop") {
  return render(
    <QueryClientProvider client={qc()}>
      <MemoryRouter>
        <ChatSidebar selectedId={null} onSelect={vi.fn()} onNewChat={vi.fn()} variant={variant} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => localStorage.clear())

describe.each(["focused", "all", "tree"])("the desktop sidebar in %s mode", (mode) => {
  beforeEach(() => localStorage.setItem("jinn-sidebar-focus-mode", mode))

  it("badges a session bound to a department", () => {
    sidebarData.sessions = [session({ scopeDepartment: "side-project" })]
    renderSidebar()
    expect(screen.getByTestId("session-department-badge").textContent).toBe("side-project")
  })

  it("shows no badge for a session that is not bound", () => {
    sidebarData.sessions = [session({ scopeDepartment: null }), session({ id: "s-2", title: "Second chat" })]
    renderSidebar()
    expect(screen.getByText("Second chat")).toBeTruthy()
    expect(screen.queryByTestId("session-department-badge")).toBeNull()
  })
})

describe("the sessions listed under an employee in the Team section", () => {
  it("badge a bound session, and only that one", () => {
    sidebarData.sessions = [session({ scopeDepartment: "side-project" }), session({ id: "s-2", title: "Second chat", scopeDepartment: null })]
    const { container } = renderSidebar()
    const before = screen.getAllByTestId("session-department-badge").length
    fireEvent.click(screen.getByText("Side Dev"))
    // The group lists the employee's sessions again, each as a grouped row of its own.
    expect(container.querySelectorAll('[data-testid="session-department-badge"]').length).toBe(before + 1)
    expect(screen.getAllByTestId("session-department-badge").every((badge) => badge.textContent === "side-project")).toBe(true)
  })
})

describe("the phone rows", () => {
  it("badges a bound session in the sidebar's phone variant", () => {
    sidebarData.sessions = [session({ scopeDepartment: "side-project" })]
    const { container } = renderSidebar("mobile")
    expect(container.querySelector('[data-row="mobile"]')).not.toBeNull()
    expect(screen.getByTestId("session-department-badge").textContent).toBe("side-project")
  })

  const row = (scopeDepartment?: string | null) =>
    render(
      <QueryClientProvider client={qc()}>
        <MemoryRouter>
          <MobileSessionRow
            session={session({ scopeDepartment })}
            avatarName="side-dev"
            displayName="Side Dev"
            selectedId={null}
            readSessions={new Set(["s-1"])}
            pinnedSessions={new Set()}
            renamingSessionId={null}
            renameCancelledRef={{ current: false }}
            fixTitle={(title?: string) => title ?? ""}
            onSelect={vi.fn()}
            togglePin={vi.fn()}
            handleDuplicate={vi.fn()}
            handleStop={vi.fn()}
            handleArchive={vi.fn()}
            setDeleteTarget={vi.fn()}
            setRenamingSessionId={vi.fn()}
            updateSessionTitle={vi.fn()}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )

  it("badges a bound session on the row itself", () => {
    row("side-project")
    expect(screen.getByTestId("session-department-badge").textContent).toBe("side-project")
  })

  it("shows nothing for an unbound session", () => {
    row(null)
    expect(screen.queryByTestId("session-department-badge")).toBeNull()
  })
})
