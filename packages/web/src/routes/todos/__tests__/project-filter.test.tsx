import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectWire } from "@/lib/project-api"
import { FilterBar } from "../filter-bar"
import { TodoFilterSheet } from "../todo-filter-sheet"

/* The Project filter: the board's desktop chip and the phone sheet's panel
 * choose a project, "No project" or any project, and show the label. */

const projectApi = vi.hoisted(() => ({ listProjects: vi.fn() }))
vi.mock("@/lib/project-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-api")>()
  return { ...actual, projectApi: { ...actual.projectApi, ...projectApi } }
})
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: { ...actual.api, listLabels: async () => ({ labels: [] }), listSprints: async () => ({ sprints: [] }) },
  }
})

function project(over: Partial<ProjectWire> & { id: string; name: string }): ProjectWire {
  return {
    archived: false,
    known: true,
    description: "",
    dedicated: false,
    instructions: "project",
    workdirs: [],
    skills: [],
    sharedNotes: [],
    members: [],
    todoCount: 0,
    spendUsd: 0,
    file: `projects/${over.id}.yaml`,
    notices: [],
    ...over,
  }
}

const GARDEN = project({ id: "prj_garden000001", name: "Garden Planner" })
const BOAT = project({ id: "prj_boat00000001", name: "Boat Club" })
const OLD = project({ id: "prj_old000000001", name: "Retired Orchard", archived: true })

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

function renderBar(filters: React.ComponentProps<typeof FilterBar>["filters"], onChange = vi.fn()) {
  render(wrap(
    <FilterBar filters={filters} onChange={onChange} employees={[]} departments={[]} byName={new Map()} hideStatus board />,
  ))
  return onChange
}

function openChip() {
  const chip = screen.getByTestId("filter-chip-project")
  fireEvent.pointerDown(chip, { button: 0, pointerType: "mouse" })
  fireEvent.click(chip)
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })),
  })
  projectApi.listProjects.mockResolvedValue({ projects: [OLD, GARDEN, BOAT] })
})

describe("the board's Project chip", () => {
  it("sits beside the Sprint chip and reads 'Project' while unset", () => {
    renderBar({ status: "open" })
    expect(screen.getByTestId("filter-chip-project").textContent).toContain("Project")
    expect(screen.getByTestId("filter-chip-project").getAttribute("aria-label")).toBe("Project")
  })

  it("lists Any, No project, live projects by name, then archived ones dimmed", async () => {
    renderBar({ status: "open" })
    openChip()
    await screen.findByTestId(`filter-project-${GARDEN.id}`)
    const menu = screen.getByRole("menu")
    const labels = [...menu.querySelectorAll("[role=menuitem]")].map((el) => el.textContent)
    expect(labels).toEqual(["Any project", "No project", "Boat Club", "Garden Planner", "Retired Orchard"])
    expect(menu.textContent).toContain("Archived")
    const archivedLabel = screen.getByTestId(`filter-project-${OLD.id}`).querySelector("span")
    expect(archivedLabel?.className).toContain("text-[var(--text-quaternary)]")
  })

  it("chooses a project, chooses 'No project', and clears with 'Any project'", async () => {
    const onChange = renderBar({ status: "open", project: GARDEN.id })
    openChip()
    fireEvent.click(await screen.findByTestId(`filter-project-${BOAT.id}`))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", project: BOAT.id })

    openChip()
    fireEvent.click(await screen.findByTestId("filter-project-none"))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", project: "none" })

    openChip()
    fireEvent.click(await screen.findByText("Any project"))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", project: undefined })
  })

  it("names the project it scopes to once set, and 'No project' for none", async () => {
    renderBar({ status: "open", project: GARDEN.id })
    await waitFor(() => expect(screen.getByTestId("filter-chip-project").textContent).toContain("Garden Planner"))
  })

  it("reads 'No project' without waiting for the registry", () => {
    renderBar({ status: "open", project: "none" })
    expect(screen.getByTestId("filter-chip-project").textContent).toContain("No project")
  })

  it("reads 'Unknown project' for an id the registry does not define", async () => {
    renderBar({ status: "open", project: "prj_nowhere00001" })
    await waitFor(() => expect(screen.getByTestId("filter-chip-project").textContent).toContain("Unknown project"))
  })
})

describe("the phone filter sheet's Project panel", () => {
  function renderSheet(filters: React.ComponentProps<typeof TodoFilterSheet>["filters"], onChange = vi.fn()) {
    render(wrap(
      <TodoFilterSheet
        filters={filters}
        onChange={onChange}
        employees={[]}
        departments={[]}
        byName={new Map()}
        onClose={vi.fn()}
        showLabelDue
      />,
    ))
    return onChange
  }

  it("is offered on the board's sheet", () => {
    renderSheet({ status: "open" })
    expect(screen.getByRole("button", { name: "Project" })).toBeTruthy()
  })

  it("is left off a sheet that has no board dimensions", () => {
    render(wrap(
      <TodoFilterSheet filters={{ status: "open" }} onChange={vi.fn()} employees={[]} departments={[]} byName={new Map()} onClose={vi.fn()} />,
    ))
    expect(screen.queryByRole("button", { name: "Project" })).toBeNull()
    expect(screen.getByRole("button", { name: "Status" })).toBeTruthy()
  })

  it("shows the current choice on the root row", async () => {
    renderSheet({ status: "open", project: GARDEN.id })
    await waitFor(() => expect(screen.getByRole("button", { name: "Project" }).textContent).toContain("Garden Planner"))
  })

  it("chooses a project and returns to the root", async () => {
    const onChange = renderSheet({ status: "open" })
    fireEvent.click(screen.getByRole("button", { name: "Project" }))
    expect(screen.getByRole("heading", { name: "Project" })).toBeTruthy()
    fireEvent.click(await screen.findByRole("button", { name: /Garden Planner/ }))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", project: GARDEN.id })
    expect(screen.getByRole("heading", { name: "Filter" })).toBeTruthy()
  })

  it("chooses 'No project' and clears with 'Any project'", async () => {
    const onChange = renderSheet({ status: "open", project: GARDEN.id })
    fireEvent.click(screen.getByRole("button", { name: "Project" }))
    fireEvent.click(screen.getByRole("button", { name: /^No project/ }))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", project: "none" })

    fireEvent.click(screen.getByRole("button", { name: "Project" }))
    fireEvent.click(screen.getByRole("button", { name: /^Any project/ }))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", project: undefined })
  })

  it("lists archived projects after the live ones, marked archived", async () => {
    renderSheet({ status: "open" })
    fireEvent.click(screen.getByRole("button", { name: "Project" }))
    await screen.findByRole("button", { name: /Retired Orchard/ })
    const rows = screen.getAllByRole("button").map((el) => el.textContent ?? "")
    const names = rows.filter((text) => /Boat Club|Garden Planner|Retired Orchard/.test(text))
    expect(names).toEqual(["Boat Club", "Garden Planner", "Retired Orchardarchived"])
  })
})
