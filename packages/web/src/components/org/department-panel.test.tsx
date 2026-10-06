import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DepartmentDefinitionWire } from "@/lib/department-api"
import { DepartmentPanel } from "./department-panel"

const get = vi.fn()
vi.mock("@/lib/department-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/department-api")>()
  return { ...actual, departmentApi: { get: (...args: unknown[]) => get(...args) } }
})

const base: DepartmentDefinitionWire = {
  slug: "side-project",
  prefix: "SID",
  scope: "scoped",
  displayName: "Side project",
  description: "A friend's side project",
  members: ["side-dev", "side-qa"],
  definitionFile: "org/side-project/department.yaml",
  definitionError: null,
  workdirs: ["/work/side-project"],
  skills: ["review", "speckit-plan"],
  sharedNotes: ["knowledge/shared/glossary.md"],
  instructions: "department+company",
  todoCount: 4,
  spendUsd: 1.5,
  warnings: [],
}

function mount(department: Partial<DepartmentDefinitionWire>, onSelectEmployee = vi.fn()) {
  get.mockResolvedValue({ ...base, ...department })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DepartmentPanel slug="side-project" onSelectEmployee={onSelectEmployee} />
    </QueryClientProvider>,
  )
  return onSelectEmployee
}

const text = (testId: string) => screen.getByTestId(testId).textContent ?? ""

beforeEach(() => get.mockReset())

describe("DepartmentPanel", () => {
  it("shows a scoped department's details, working directories, skills, Notes and instructions", async () => {
    mount({})
    await screen.findByTestId("department-panel")
    expect(screen.getByRole("heading", { name: "Side project" })).toBeTruthy()
    expect(screen.getByTestId("department-scope-badge").textContent).toBe("Scoped")
    expect(text("department-scope")).toMatch(/Scoped\. Its employees are confined/)
    expect(text("department-scope")).toMatch(/Read-only/)
    expect(text("department-workdirs")).toContain("/work/side-project")
    expect(text("department-skills")).toBe("Skillsreviewspeckit-plan")
    expect(text("department-shared-notes")).toContain("knowledge/shared/glossary.md")
    expect(text("department-instructions")).toMatch(/then the company's/)
    expect(text("department-work")).toBe("Work4 Todos · $1.50 spent")
    expect(text("department-yaml")).toContain("org/side-project/department.yaml")
    expect(screen.queryByTestId("department-definition-error")).toBeNull()
  })

  it("says what a dedicated department means", async () => {
    mount({ scope: "dedicated" })
    await screen.findByTestId("department-panel")
    expect(text("department-scope")).toMatch(/only they can hold its Todos/)
    expect(screen.getByTestId("department-scope-badge").textContent).toBe("Dedicated")
  })

  it("shows an open department with no badge and no scoped sections", async () => {
    mount({ scope: "open", workdirs: [], skills: [], sharedNotes: [], definitionFile: null, displayName: null, description: null, todoCount: 1, instructions: "department" })
    await screen.findByTestId("department-panel")
    expect(screen.queryByTestId("department-scope-badge")).toBeNull()
    expect(screen.getByRole("heading", { name: "Side Project" })).toBeTruthy()
    expect(text("department-scope")).toMatch(/Open\. No restriction/)
    expect(screen.getByTestId("department-open-note")).toBeTruthy()
    expect(screen.queryByTestId("department-workdirs")).toBeNull()
    expect(text("department-work")).toBe("Work1 Todo · $1.50 spent")
    expect(text("department-yaml")).toMatch(/has no definition yet\. Create org\/side-project\/department\.yaml/)
  })

  it("shows why a refused department.yaml was refused, and the scope the department keeps", async () => {
    mount({ definitionError: "name \"x\" does not match the directory \"side-project\"" })
    const alert = await screen.findByTestId("department-definition-error")
    expect(alert.textContent).toContain("department.yaml was refused:")
    expect(alert.textContent).toContain("does not match the directory")
    expect(alert.textContent).toContain("The department stays scoped until the file is fixed")
    expect(screen.getByTestId("department-scope-badge").textContent).toBe("Scoped")
  })

  it("lists the entries the scan dropped", async () => {
    mount({ warnings: ["skills: dropped \"nope\", which is not an installed skill"] })
    await screen.findByTestId("department-panel")
    expect(text("department-warnings")).toContain("dropped \"nope\"")
  })

  it("opens a member's panel", async () => {
    const onSelect = mount({})
    fireEvent.click(await screen.findByRole("button", { name: "side-qa" }))
    expect(onSelect).toHaveBeenCalledWith("side-qa")
  })

  it("says so when a department has no members", async () => {
    mount({ members: [] })
    await screen.findByTestId("department-panel")
    expect(text("department-members")).toBe("Members (0)No employees.")
  })
})
