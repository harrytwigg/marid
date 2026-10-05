import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useSidebarSessions } from "@/components/chat/sidebar-sessions"
import { resetActiveProjectForTests, setActiveProject } from "@/hooks/use-active-project"
import { GARDEN } from "@/test/project-fixture"
import { fetchProjectTodoIds } from "../use-project-scope"

const projectApi = vi.hoisted(() => ({ listProjects: vi.fn() }))
const workItems = vi.hoisted(() => ({ listWorkItems: vi.fn() }))
vi.mock("@/lib/project-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-api")>()
  return { ...actual, projectApi: { ...actual.projectApi, ...projectApi } }
})
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { ...actual.api, ...workItems } }
})

const SESSIONS = [
  { id: "s1", workItemId: "TST-1", source: "web", lastActivity: "2026-01-03" },
  { id: "s2", workItemId: "TST-9", source: "web", lastActivity: "2026-01-02" },
  { id: "s3", workItemId: null, source: "web", lastActivity: "2026-01-01" },
]

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(() => useSidebarSessions(SESSIONS, []), {
    wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  resetActiveProjectForTests()
  projectApi.listProjects.mockResolvedValue({ projects: [GARDEN] })
  workItems.listWorkItems.mockResolvedValue({ workItems: [{ id: "TST-1" }], nextOffset: null })
})

describe("sidebar sessions and the active project", () => {
  it("lists every session when no project is active, asking nothing", () => {
    const { result } = render()
    expect(result.current.map((s) => s.id)).toEqual(["s1", "s2", "s3"])
    expect(workItems.listWorkItems).not.toHaveBeenCalled()
  })

  it("keeps only sessions linked to the project's Todos, hiding unlinked ones", async () => {
    setActiveProject(GARDEN.id)
    const { result } = render()
    await waitFor(() => expect(result.current.map((s) => s.id)).toEqual(["s1"]))
    expect(workItems.listWorkItems).toHaveBeenCalledWith({ project: GARDEN.id, limit: 100, offset: undefined }, expect.anything())
  })

  it("lists everything again once the project is cleared", async () => {
    setActiveProject(GARDEN.id)
    const { result } = render()
    await waitFor(() => expect(result.current).toHaveLength(1))
    setActiveProject(undefined)
    await waitFor(() => expect(result.current).toHaveLength(3))
  })

  it("does not hide chats behind a leftover choice when no project exists", async () => {
    projectApi.listProjects.mockResolvedValue({ projects: [] })
    setActiveProject("prj_gone00000001")
    const { result } = render()
    await waitFor(() => expect(projectApi.listProjects).toHaveBeenCalled())
    expect(result.current).toHaveLength(3)
  })
})

describe("fetchProjectTodoIds", () => {
  it("follows nextOffset across pages", async () => {
    workItems.listWorkItems
      .mockResolvedValueOnce({ workItems: [{ id: "TST-1" }, { id: "TST-2" }], nextOffset: 100 })
      .mockResolvedValueOnce({ workItems: [{ id: "TST-3" }], nextOffset: null })
    expect((await fetchProjectTodoIds(GARDEN.id)).ids).toEqual(["TST-1", "TST-2", "TST-3"])
    expect(workItems.listWorkItems).toHaveBeenLastCalledWith({ project: GARDEN.id, limit: 100, offset: 100 }, undefined)
  })

  it("stops at the page cap", async () => {
    workItems.listWorkItems.mockResolvedValue({ workItems: [{ id: "TST-1" }], nextOffset: 1 })
    await fetchProjectTodoIds(GARDEN.id)
    expect(workItems.listWorkItems).toHaveBeenCalledTimes(20)
  })
})
