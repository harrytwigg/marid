import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { resetActiveProjectForTests } from "@/hooks/use-active-project"
import { GARDEN } from "@/test/project-fixture"
import { StatusBar } from "@/components/status-bar"

const projectApi = vi.hoisted(() => ({ listProjects: vi.fn() }))
vi.mock("@/lib/project-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-api")>()
  return { ...actual, projectApi: { ...actual.projectApi, ...projectApi } }
})
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark", setTheme: vi.fn() }) }))
vi.mock("@/components/workspaces/workspace-menu", () => ({ WorkspaceSwitcher: () => <button aria-label="Switch workspace" /> }))

function renderBar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <StatusBar />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  resetActiveProjectForTests()
})

describe("project switcher in the status bar", () => {
  it("sits between the workspace switcher and the theme toggle once a project exists", async () => {
    projectApi.listProjects.mockResolvedValue({ projects: [GARDEN] })
    renderBar()
    const switcher = await screen.findByRole("button", { name: "Project: All projects" })
    const order = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))
    expect(order).toEqual(["Switch workspace", switcher.getAttribute("aria-label"), "Theme: dark"])
  })

  it("leaves the bar as it was with no projects", async () => {
    projectApi.listProjects.mockResolvedValue({ projects: [] })
    renderBar()
    await waitFor(() => expect(projectApi.listProjects).toHaveBeenCalled())
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Switch workspace", "Theme: dark"])
  })
})
