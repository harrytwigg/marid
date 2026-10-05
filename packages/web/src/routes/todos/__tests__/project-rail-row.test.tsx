import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api"
import type { ProjectRefWire, ProjectWire } from "@/lib/project-api"

/* The Todo page's Project row: move a top-level Todo into a project or out of
 * one, show the gateway's refusal, and read a sub-task's project from its root. */

const projectApi = vi.hoisted(() => ({ listProjects: vi.fn(), setWorkItemProject: vi.fn() }))
vi.mock("@/lib/project-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-api")>()
  return { ...actual, projectApi: { ...actual.projectApi, ...projectApi } }
})

const { ProjectRailRow } = await import("../projects/project-rail-row")

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

function ref(p: ProjectWire): ProjectRefWire {
  return { id: p.id, name: p.name, archived: p.archived, known: p.known }
}

function detail(over: { parentId?: string | null; rootId?: string; project?: ProjectRefWire | null }) {
  return {
    workItem: { id: "PLA-7", parentId: over.parentId ?? null, rootId: over.rootId ?? "PLA-7", status: "backlog" },
    project: over.project === undefined ? null : over.project,
  } as unknown as React.ComponentProps<typeof ProjectRailRow>["detail"]
}

function renderRow(props: React.ComponentProps<typeof ProjectRailRow>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><ProjectRailRow {...props} /></QueryClientProvider>)
}

function openMenu() {
  fireEvent.pointerDown(screen.getByTestId("rail-project"), { button: 0, ctrlKey: false, pointerType: "mouse" })
}

beforeEach(() => {
  for (const fn of Object.values(projectApi)) fn.mockReset()
  projectApi.listProjects.mockResolvedValue({ projects: [OLD, GARDEN, BOAT] })
})

describe("the Todo page's Project row", () => {
  it("shows the current project", () => {
    renderRow({ detail: detail({ project: ref(GARDEN) }), editable: true })
    expect(screen.getByTestId("rail-project").textContent).toContain("Garden Planner")
  })

  it("reads 'No project' for a company-level Todo", () => {
    renderRow({ detail: detail({}), editable: true })
    expect(screen.getByTestId("rail-project").textContent).toContain("No project")
  })

  it("opens the menu from a press on the row and moves the Todo", async () => {
    projectApi.setWorkItemProject.mockResolvedValue({ project: ref(BOAT), version: 2 })
    renderRow({ detail: detail({ project: ref(GARDEN) }), editable: true })
    openMenu()
    fireEvent.click(await screen.findByTestId(`rail-project-${BOAT.id}`))
    await waitFor(() => expect(projectApi.setWorkItemProject).toHaveBeenCalledWith("PLA-7", BOAT.id))
  })

  it("never offers an archived project as a destination", async () => {
    renderRow({ detail: detail({}), editable: true })
    openMenu()
    await screen.findByTestId(`rail-project-${GARDEN.id}`)
    expect(screen.queryByTestId(`rail-project-${OLD.id}`)).toBeNull()
  })

  it("moves the Todo out of its project with 'No project'", async () => {
    projectApi.setWorkItemProject.mockResolvedValue({ project: null, version: 2 })
    renderRow({ detail: detail({ project: ref(GARDEN) }), editable: true })
    openMenu()
    fireEvent.click(await screen.findByTestId("rail-project-none"))
    await waitFor(() => expect(projectApi.setWorkItemProject).toHaveBeenCalledWith("PLA-7", null))
  })

  it("shows the gateway's own refusal when a move is refused", async () => {
    projectApi.setWorkItemProject.mockRejectedValue(new ApiError(400, "project prj_garden000001 is archived"))
    renderRow({ detail: detail({}), editable: true })
    openMenu()
    fireEvent.click(await screen.findByTestId(`rail-project-${GARDEN.id}`))
    expect((await screen.findByRole("alert")).textContent).toContain("is archived")
  })

  it("marks an archived current project as archived", () => {
    renderRow({ detail: detail({ project: ref(OLD) }), editable: true })
    expect(screen.getByTestId("rail-project").textContent).toContain("archived")
  })

  it("reads 'unknown project' for an id with no definition", () => {
    renderRow({ detail: detail({ project: { id: "prj_gone00000001", name: "prj_gone00000001", archived: false, known: false } }), editable: true })
    expect(screen.getByTestId("rail-project").textContent).toContain("unknown project")
  })

  it("reads a sub-task's project from its root, read-only, with a hint that it follows the root", () => {
    renderRow({ detail: detail({ parentId: "PLA-3", rootId: "PLA-3", project: ref(GARDEN) }), editable: true })
    const row = screen.getByTestId("rail-project")
    expect(row.tagName).toBe("DIV")
    expect(row.textContent).toContain("Garden Planner")
    expect(row.textContent).toContain("follows PLA-3")
    fireEvent.pointerDown(row, { button: 0, pointerType: "mouse" })
    expect(screen.queryByTestId("rail-project-none")).toBeNull()
    expect(projectApi.listProjects).not.toHaveBeenCalled()
  })

  it("is read-only when the page offers no edits", () => {
    renderRow({ detail: detail({ project: ref(GARDEN) }), editable: false })
    expect(screen.getByTestId("rail-project").tagName).toBe("DIV")
  })
})
