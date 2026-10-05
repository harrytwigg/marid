import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectWire } from "@/lib/project-api"
import { NewTodoDialog } from "../new-todo-dialog"

/* The create dialog's Project chip: choose a project (or none) for a new
 * top-level Todo, start in the board's filtered project, and offer nothing for
 * a sub-task. */

vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const createWorkItem = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      createWorkItem: (...args: unknown[]) => createWorkItem(...args),
      assignWorkItem: async () => ({}),
      listLabels: async () => ({ labels: [] }),
    },
  }
})

const projectApi = vi.hoisted(() => ({ listProjects: vi.fn() }))
vi.mock("@/lib/project-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-api")>()
  return { ...actual, projectApi: { ...actual.projectApi, ...projectApi } }
})

function project(over: Partial<ProjectWire> & { id: string; name: string }): ProjectWire {
  return {
    archived: false, known: true, description: "", dedicated: false, instructions: "project",
    workdirs: [], skills: [], sharedNotes: [], members: [], todoCount: 0, spendUsd: 0,
    file: `projects/${over.id}.yaml`, notices: [], ...over,
  }
}

const GARDEN = project({ id: "prj_garden000001", name: "Garden Planner" })
const BOAT = project({ id: "prj_boat00000001", name: "Boat Club" })
const OLD = project({ id: "prj_old000000001", name: "Retired Orchard", archived: true })

function renderDialog(defaults: React.ComponentProps<typeof NewTodoDialog>["defaults"] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onCreated = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <NewTodoDialog onClose={vi.fn()} onCreated={onCreated} defaults={{ employees: [], departments: [], ...defaults }} />
    </QueryClientProvider>,
  )
  return { onCreated }
}

beforeEach(() => {
  vi.clearAllMocks()
  createWorkItem.mockResolvedValue({ workItem: { id: "PLA-9" } })
  projectApi.listProjects.mockResolvedValue({ projects: [OLD, GARDEN, BOAT] })
})

describe("the create dialog's Project chip", () => {
  it("sends the chosen project with the create", async () => {
    const user = userEvent.setup()
    const { onCreated } = renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "Water the beds")
    expect(screen.getByTestId("todo-new-project-chip").textContent).toContain("Project")
    await user.click(screen.getByTestId("todo-new-project-chip"))
    await user.click(await screen.findByTestId(`project-option-${GARDEN.id}`))
    expect(screen.getByTestId("todo-new-project-chip").textContent).toContain("Garden Planner")
    await user.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(createWorkItem).toHaveBeenCalledWith(expect.objectContaining({ title: "Water the beds", project: GARDEN.id }))
  })

  it("sends no project when none is chosen", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "Sand the hull")
    await user.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(createWorkItem).toHaveBeenCalledTimes(1))
    expect(createWorkItem.mock.calls[0][0]).not.toHaveProperty("project")
  })

  it("offers only live projects, plus 'No project'", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByTestId("todo-new-project-chip"))
    await screen.findByTestId(`project-option-${BOAT.id}`)
    const picker = screen.getByTestId("todo-new-project-picker")
    expect(screen.getByTestId("project-option-none")).toBeTruthy()
    expect(screen.getByTestId(`project-option-${GARDEN.id}`)).toBeTruthy()
    expect(screen.queryByTestId(`project-option-${OLD.id}`)).toBeNull()
    expect(picker.textContent).not.toContain("Retired Orchard")
  })

  it("clears a choice with 'No project'", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "Paint the shed")
    await user.click(screen.getByTestId("todo-new-project-chip"))
    await user.click(await screen.findByTestId(`project-option-${BOAT.id}`))
    await user.click(screen.getByTestId("todo-new-project-chip"))
    await user.click(await screen.findByTestId("project-option-none"))
    expect(screen.getByTestId("todo-new-project-chip").textContent).toContain("Project")
    await user.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(createWorkItem).toHaveBeenCalledTimes(1))
    expect(createWorkItem.mock.calls[0][0]).not.toHaveProperty("project")
  })

  it("starts in the project the board is filtered to", async () => {
    const user = userEvent.setup()
    renderDialog({ project: GARDEN.id })
    await waitFor(() => expect(screen.getByTestId("todo-new-project-chip").textContent).toContain("Garden Planner"))
    await user.type(screen.getByTestId("todo-new-title"), "Prune the roses")
    await user.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(createWorkItem).toHaveBeenCalledWith(expect.objectContaining({ project: GARDEN.id })))
  })

  it("starts company-level when the board is filtered to an archived project", async () => {
    const user = userEvent.setup()
    renderDialog({ project: OLD.id })
    await user.type(screen.getByTestId("todo-new-title"), "Gather the windfalls")
    await waitFor(() => expect(projectApi.listProjects).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId("todo-new-project-chip").textContent).toContain("Project"))
    await user.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(createWorkItem).toHaveBeenCalledTimes(1))
    expect(createWorkItem.mock.calls[0][0]).not.toHaveProperty("project")
  })

  it("starts company-level when the board is filtered to 'No project'", async () => {
    const user = userEvent.setup()
    renderDialog({ project: "none" })
    await user.type(screen.getByTestId("todo-new-title"), "Renew the lease")
    await user.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(createWorkItem).toHaveBeenCalledTimes(1))
    expect(createWorkItem.mock.calls[0][0]).not.toHaveProperty("project")
  })

  it("hides the chip and sends no project once a parent Todo is named", async () => {
    const user = userEvent.setup()
    renderDialog({ project: GARDEN.id })
    await user.type(screen.getByTestId("todo-new-title"), "Weed the border")
    await user.click(screen.getByTestId("todo-new-parent-chip"))
    await user.type(screen.getByTestId("todo-new-parent"), "PLA-2")
    expect(screen.queryByTestId("todo-new-project-chip")).toBeNull()
    await user.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(createWorkItem).toHaveBeenCalledTimes(1))
    const sent = createWorkItem.mock.calls[0][0]
    expect(sent).toMatchObject({ parentId: "PLA-2" })
    expect(sent).not.toHaveProperty("project")
  })

  it("shows the chip again if the parent is cleared", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByTestId("todo-new-parent-chip"))
    await user.type(screen.getByTestId("todo-new-parent"), "PLA-2")
    expect(screen.queryByTestId("todo-new-project-chip")).toBeNull()
    await user.clear(screen.getByTestId("todo-new-parent"))
    expect(screen.getByTestId("todo-new-project-chip")).toBeTruthy()
  })
})
