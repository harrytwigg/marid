import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getActiveProject, resetActiveProjectForTests, setActiveProject } from "@/hooks/use-active-project"
import { BOAT, GARDEN, RETIRED } from "@/test/project-fixture"
import { ProjectSwitcher } from "../project-switcher"
import { SidebarProjectBar } from "../sidebar-project-bar"

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

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  resetActiveProjectForTests()
  workItems.listWorkItems.mockResolvedValue({ workItems: [], nextOffset: null })
})

describe("ProjectSwitcher", () => {
  it("renders nothing when no project exists", async () => {
    projectApi.listProjects.mockResolvedValue({ projects: [] })
    const { container } = render(wrap(<ProjectSwitcher />))
    await waitFor(() => expect(projectApi.listProjects).toHaveBeenCalled())
    expect(container.innerHTML).toBe("")
  })

  it("lists All projects and the live projects, choosing and clearing", async () => {
    projectApi.listProjects.mockResolvedValue({ projects: [GARDEN, BOAT, RETIRED] })
    const user = userEvent.setup()
    render(wrap(<ProjectSwitcher />))
    await user.click(await screen.findByRole("button", { name: "Project: All projects" }))
    expect(screen.getByRole("menuitem", { name: "All projects" })).toBeTruthy()
    expect(screen.queryByRole("menuitem", { name: "Retired Orchard" })).toBeNull()
    await user.click(screen.getByRole("menuitem", { name: "Garden Planner" }))
    expect(getActiveProject()).toBe(GARDEN.id)
    await user.click(await screen.findByRole("button", { name: "Project: Garden Planner" }))
    await user.click(screen.getByRole("menuitem", { name: "All projects" }))
    expect(getActiveProject()).toBeUndefined()
  })
})

describe("SidebarProjectBar", () => {
  it("renders nothing without projects", async () => {
    projectApi.listProjects.mockResolvedValue({ projects: [] })
    const { container } = render(wrap(<SidebarProjectBar />))
    await waitFor(() => expect(projectApi.listProjects).toHaveBeenCalled())
    expect(container.innerHTML).toBe("")
  })

  it("says which project narrows the list and clears it", async () => {
    projectApi.listProjects.mockResolvedValue({ projects: [GARDEN] })
    setActiveProject(GARDEN.id)
    const user = userEvent.setup()
    render(wrap(<SidebarProjectBar />))
    expect(await screen.findByText("Showing project Garden Planner")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "clear" }))
    expect(getActiveProject()).toBeUndefined()
    await waitFor(() => expect(screen.queryByText(/Showing project/)).toBeNull())
    await act(async () => {})
  })
})
