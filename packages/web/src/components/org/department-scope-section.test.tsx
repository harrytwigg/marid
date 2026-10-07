import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DepartmentPatchError, type DepartmentDefinitionWire } from "@/lib/department-api"
import { DepartmentPanel } from "./department-panel"

const get = vi.fn()
const patch = vi.fn()
vi.mock("@/lib/department-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/department-api")>()
  return { ...actual, departmentApi: { get: (...args: unknown[]) => get(...args), patch: (...args: unknown[]) => patch(...args) } }
})

const base: DepartmentDefinitionWire = {
  slug: "side-project",
  prefix: "SID",
  scope: "open",
  displayName: "Side project",
  description: null,
  members: ["side-dev"],
  definitionFile: "org/side-project/department.yaml",
  definitionError: null,
  workdirs: [],
  skills: [],
  mcp: [],
  sharedNotes: [],
  instructions: "department",
  todoCount: 2,
  spendUsd: 0,
  warnings: [],
}

let queryClient: QueryClient

function mount(department: Partial<DepartmentDefinitionWire> = {}) {
  const loaded = { ...base, ...department }
  get.mockResolvedValue(loaded)
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DepartmentPanel slug={loaded.slug} onSelectEmployee={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return screen.findByTestId("department-scope")
}

const radio = (name: string) => screen.getByRole("radio", { name })
const scopeText = () => screen.getByTestId("department-scope").textContent ?? ""

beforeEach(() => {
  get.mockReset()
  patch.mockReset()
})

describe("the department panel's scope control", () => {
  it("offers Open, Scoped and Dedicated with the current scope selected", async () => {
    await mount({ scope: "scoped" })
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Open", "Scoped", "Dedicated"])
    expect(radio("Scoped").getAttribute("aria-checked")).toBe("true")
    expect(radio("Open").getAttribute("aria-checked")).toBe("false")
    expect(screen.queryByRole("button", { name: "Save scope" })).toBeNull()
  })

  it("only stages a pick: nothing is sent until Save, then the panel and the lists update", async () => {
    await mount()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    patch.mockResolvedValue({ ...base, scope: "scoped" })

    fireEvent.click(radio("Scoped"))
    expect(patch).not.toHaveBeenCalled()
    expect(radio("Scoped").getAttribute("aria-checked")).toBe("true")
    expect(scopeText()).toMatch(/Scoped\. Its employees are confined/)
    // The panel still shows the saved scope until the change lands.
    expect(screen.getByTestId("department-panel").getAttribute("data-scope")).toBe("open")

    fireEvent.click(screen.getByRole("button", { name: "Save scope" }))
    await waitFor(() => expect(screen.getByTestId("department-panel").getAttribute("data-scope")).toBe("scoped"))
    expect(patch).toHaveBeenCalledExactlyOnceWith("side-project", { scope: "scoped" })
    expect(queryClient.getQueryData(["departments", "definition", "side-project"])).toMatchObject({ scope: "scoped" })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["departments"], exact: true })
    expect(screen.queryByRole("button", { name: "Save scope" })).toBeNull()
    expect(screen.getByTestId("department-scope-badge").textContent).toBe("Scoped")
  })

  it("sends nothing on Cancel and goes back to the saved scope", async () => {
    await mount()
    fireEvent.click(radio("Dedicated"))
    expect(scopeText()).toMatch(/only they can hold its Todos/)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(patch).not.toHaveBeenCalled()
    expect(radio("Open").getAttribute("aria-checked")).toBe("true")
    expect(screen.queryByRole("button", { name: "Save scope" })).toBeNull()
  })

  it("picking the saved scope again clears the staged change", async () => {
    await mount()
    fireEvent.click(radio("Scoped"))
    fireEvent.click(radio("Open"))
    expect(screen.queryByTestId("department-scope-staged")).toBeNull()
  })

  it("disables the control and both buttons while the change is pending", async () => {
    await mount()
    patch.mockReturnValue(new Promise(() => {}))
    fireEvent.click(radio("Scoped"))
    fireEvent.click(screen.getByRole("button", { name: "Save scope" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Saving..." })).toBeTruthy())
    expect((screen.getByRole("button", { name: "Saving..." }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true)
    for (const r of screen.getAllByRole("radio")) expect((r as HTMLButtonElement).disabled).toBe(true)
  })

  it("lists each Todo that would be stranded, as a link, with its holder, and keeps the staged choice", async () => {
    await mount({ scope: "scoped" })
    patch.mockRejectedValue(new DepartmentPatchError(409, "2 Todos would be stranded", "department-boundary", [
      { todo: "SID-1", assignee: "open-dev" },
      { todo: "SID-7", assignee: "other-dev" },
    ]))
    fireEvent.click(radio("Dedicated"))
    fireEvent.click(screen.getByRole("button", { name: "Save scope" }))

    const alert = await screen.findByTestId("department-scope-error")
    expect(alert.getAttribute("role")).toBe("alert")
    expect(alert.textContent).toContain("2 Todos would be stranded")
    const links = within(alert).getAllByRole("link")
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["SID-1", "/todos/SID-1"],
      ["SID-7", "/todos/SID-7"],
    ])
    expect(within(screen.getByTestId("department-scope-holders")).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "SID-1held by open-dev",
      "SID-7held by other-dev",
    ])
    expect(radio("Dedicated").getAttribute("aria-checked")).toBe("true")
    expect(screen.getByRole("button", { name: "Save scope" })).toBeTruthy()
    expect(screen.getByTestId("department-panel").getAttribute("data-scope")).toBe("scoped")
  })

  it("shows any other refusal's text in the same alert, with no holder list", async () => {
    await mount()
    patch.mockRejectedValue(new DepartmentPatchError(409, "department.yaml could not be parsed"))
    fireEvent.click(radio("Scoped"))
    fireEvent.click(screen.getByRole("button", { name: "Save scope" }))
    expect((await screen.findByTestId("department-scope-error")).textContent).toBe("department.yaml could not be parsed")
    expect(screen.queryByTestId("department-scope-holders")).toBeNull()
  })

  it("offers no control for a department whose file was refused", async () => {
    await mount({ definitionError: "bad yaml" })
    expect(screen.queryByRole("radio")).toBeNull()
    expect(scopeText()).toContain("cannot be changed until department.yaml is fixed")
  })

  it.each(["system", "org"])("offers no control for %s, which cannot be scoped", async (slug) => {
    await mount({ slug })
    expect(screen.queryByRole("radio")).toBeNull()
    expect(scopeText()).toContain("cannot be scoped")
  })
})
