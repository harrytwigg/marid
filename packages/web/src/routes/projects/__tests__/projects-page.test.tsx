import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BOAT, GARDEN, makeProject } from "@/test/project-fixture"
import ProjectsPage from "../page"

const projectApi = vi.hoisted(() => ({ listProjects: vi.fn(), createProject: vi.fn(), updateProject: vi.fn() }))
vi.mock("@/lib/project-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-api")>()
  return { ...actual, projectApi: { ...actual.projectApi, ...projectApi } }
})
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ProjectsPage />
    </QueryClientProvider>,
  )
}

function list(...projects: ReturnType<typeof makeProject>[]) {
  projectApi.listProjects.mockResolvedValue({ projects })
}

async function openCard(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `${name} project` }))
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe("Projects page", () => {
  it("lists projects with their Todo count and spend", async () => {
    list(GARDEN, BOAT)
    renderPage()
    const card = await screen.findByTestId(`project-card-${GARDEN.id}`)
    expect(within(card).getByText(/3 Todos · \$1\.50 spent/)).toBeTruthy()
    expect(screen.getByTestId(`project-card-${BOAT.id}`)).toBeTruthy()
  })

  it("explains where projects come from when there are none", async () => {
    list()
    renderPage()
    const empty = await screen.findByTestId("projects-empty")
    expect(empty.textContent).toContain("projects/")
    expect(empty.textContent).toContain("create one here")
  })

  it("creates a project from a name and a description", async () => {
    list()
    projectApi.createProject.mockResolvedValue({ project: GARDEN })
    renderPage()
    fireEvent.click(await screen.findByRole("button", { name: "New project" }))
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Garden Planner" } })
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Plan the allotment" } })
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    await waitFor(() =>
      expect(projectApi.createProject).toHaveBeenCalledWith({ name: "Garden Planner", description: "Plan the allotment" }),
    )
    await waitFor(() => expect(screen.queryByTestId("project-create-form")).toBeNull())
  })

  it("saves an edited name", async () => {
    list(GARDEN)
    projectApi.updateProject.mockResolvedValue({ project: GARDEN })
    renderPage()
    fireEvent.change(await screen.findByLabelText("Project name"), { target: { value: "Allotment" } })
    fireEvent.click(screen.getByRole("button", { name: "Save details" }))
    await waitFor(() =>
      expect(projectApi.updateProject).toHaveBeenCalledWith(GARDEN.id, { name: "Allotment", description: "Plan the allotment" }),
    )
  })

  it("shows the server's message when it refuses an edit", async () => {
    list(GARDEN)
    projectApi.updateProject.mockRejectedValue(new Error("Project is dedicated and cannot be changed yet"))
    renderPage()
    fireEvent.change(await screen.findByLabelText("Add skill"), { target: { value: "pruning" } })
    fireEvent.submit(screen.getByLabelText("Add skill").closest("form")!)
    expect((await screen.findByRole("alert")).textContent).toBe("Project is dedicated and cannot be changed yet")
    expect(projectApi.updateProject).toHaveBeenCalledWith(GARDEN.id, { skills: ["watering", "pruning"] })
  })

  it("adds and removes directory and note entries as whole-list saves", async () => {
    list(GARDEN)
    projectApi.updateProject.mockResolvedValue({ project: GARDEN })
    renderPage()
    fireEvent.click(await screen.findByRole("button", { name: "Remove knowledge/garden.md" }))
    await waitFor(() => expect(projectApi.updateProject).toHaveBeenCalledWith(GARDEN.id, { sharedNotes: [] }))
    fireEvent.change(screen.getByLabelText("Add working directory"), { target: { value: "~/plots/shed" } })
    fireEvent.submit(screen.getByLabelText("Add working directory").closest("form")!)
    await waitFor(() =>
      expect(projectApi.updateProject).toHaveBeenCalledWith(GARDEN.id, { workdirs: ["~/plots/garden", "~/plots/shed"] }),
    )
  })

  it("toggles archive through the Archive section", async () => {
    list(GARDEN)
    projectApi.updateProject.mockResolvedValue({ project: GARDEN })
    renderPage()
    fireEvent.click(await screen.findByRole("switch", { name: "Archived" }))
    await waitFor(() => expect(projectApi.updateProject).toHaveBeenCalledWith(GARDEN.id, { archived: true }))
  })

  it("shows dedicated read-only and never sends it", async () => {
    list(makeProject({ id: GARDEN.id, name: "Garden Planner", dedicated: true }))
    projectApi.updateProject.mockResolvedValue({ project: GARDEN })
    renderPage()
    const line = await screen.findByTestId("project-dedicated")
    expect(line.textContent).toContain("Dedicated: yes")
    expect(line.textContent).toContain("not editable yet")
    expect(within(line).queryByRole("switch")).toBeNull()
    expect(within(line).queryByRole("checkbox")).toBeNull()
  })

  it("shows the empty members state", async () => {
    list(GARDEN)
    renderPage()
    expect(await screen.findByText("No scoped employees yet")).toBeTruthy()
  })

  it("points at the YAML file and copies its path", async () => {
    list(GARDEN)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    renderPage()
    expect((await screen.findByTestId("project-yaml-path")).textContent).toBe("projects/garden-planner.yaml")
    fireEvent.click(screen.getByRole("button", { name: "Copy path projects/garden-planner.yaml" }))
    expect(writeText).toHaveBeenCalledWith("projects/garden-planner.yaml")
    expect(await screen.findByText("Copied")).toBeTruthy()
  })

  it("shows notices as warnings on the card", async () => {
    list(makeProject({ id: BOAT.id, name: "Boat Club", notices: ['id previously used by "Old Dinghy"'] }), GARDEN)
    renderPage()
    expect(await screen.findByText('id previously used by "Old Dinghy"')).toBeTruthy()
  })

  it("keeps the sections closed when several projects are listed", async () => {
    list(GARDEN, BOAT)
    renderPage()
    await screen.findByTestId(`project-card-${GARDEN.id}`)
    expect(screen.queryByLabelText("Project name")).toBeNull()
    await openCard("Boat Club")
    expect(screen.getByLabelText("Project name")).toBeTruthy()
  })
})
