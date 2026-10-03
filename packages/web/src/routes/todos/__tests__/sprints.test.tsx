import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SprintWire } from "@/lib/sprint-api"
import { filtersFromSearchParams, filtersToSearchParams, activeFilterCount } from "@/lib/todos"

/* Sprints on the web: the `sprint` filter's URL round trip and chip label, and
 * the planner dialog's create and complete flows against a mocked gateway. */

const sprintApi = vi.hoisted(() => ({
  listSprints: vi.fn(),
  createSprint: vi.fn(),
  completeSprint: vi.fn(),
  startSprint: vi.fn(),
  deleteSprint: vi.fn(),
}))

vi.mock("@/lib/sprint-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sprint-api")>()
  return { ...actual, sprintApi: { ...actual.sprintApi, ...sprintApi } }
})

const { SprintsDialog } = await import("../sprints/sprints-dialog")
const { resolveSprintFilter, sprintFilterLabel } = await import("../sprints/use-sprints")

function sprint(over: Partial<SprintWire> & { id: string; name: string }): SprintWire {
  return {
    status: "planned",
    goal: null,
    startsAt: null,
    endsAt: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    startedAt: null,
    closedAt: null,
    open: 0,
    total: 0,
    ...over,
  }
}

const ACTIVE = sprint({ id: "spr_aaaaaaaaaaaa", name: "Sprint 1", status: "active", open: 3, total: 5 })
const NEXT = sprint({ id: "spr_bbbbbbbbbbbb", name: "Sprint 2", startsAt: "2026-10-12", endsAt: "2026-10-23" })
const OLD = sprint({ id: "spr_cccccccccccc", name: "Sprint 0", status: "closed", open: 0, total: 4 })

function renderDialog(props: Partial<React.ComponentProps<typeof SprintsDialog>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onShowOnBoard = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <SprintsDialog open onOpenChange={() => {}} onShowOnBoard={onShowOnBoard} {...props} />
    </QueryClientProvider>,
  )
  return { onShowOnBoard }
}

beforeEach(() => {
  for (const fn of Object.values(sprintApi)) fn.mockReset()
  sprintApi.listSprints.mockResolvedValue({ sprints: [ACTIVE, NEXT, OLD] })
})

describe("the sprint filter", () => {
  it("round-trips through the URL and counts as a set filter", () => {
    const filters = filtersFromSearchParams(new URLSearchParams("sprint=spr_aaaaaaaaaaaa&label=bug"))
    expect(filters).toMatchObject({ status: "open", sprint: "spr_aaaaaaaaaaaa", label: "bug" })
    expect(activeFilterCount(filters)).toBe(2)
    expect(filtersToSearchParams(filters).get("sprint")).toBe("spr_aaaaaaaaaaaa")
    expect(filtersToSearchParams({ status: "open" }).has("sprint")).toBe(false)
  })

  it("names the sprint it scopes to, and still reads as set when the sprint is gone", () => {
    const all = [ACTIVE, NEXT, OLD]
    expect(sprintFilterLabel(undefined, all)).toBeUndefined()
    expect(sprintFilterLabel("none", all)).toBe("No sprint")
    expect(sprintFilterLabel("active", all)).toBe("Sprint 1 (active)")
    expect(sprintFilterLabel("active", [NEXT])).toBe("Active sprint")
    expect(sprintFilterLabel(NEXT.id, all)).toBe("Sprint 2")
    expect(sprintFilterLabel("spr_dddddddddddd", all)).toBe("Sprint")
    expect(resolveSprintFilter(all, "sprint 2")?.id).toBe(NEXT.id)
  })
})

describe("the sprint planner", () => {
  it("lists sprints by state and creates a new one", async () => {
    sprintApi.createSprint.mockResolvedValue({ sprint: sprint({ id: "spr_eeeeeeeeeeee", name: "Sprint 3" }) })
    renderDialog()
    expect(await screen.findByTestId(`sprint-row-${ACTIVE.id}`)).toBeTruthy()
    expect(screen.getByTestId(`sprint-row-${NEXT.id}`).textContent).toMatch(/Oct/)
    expect(screen.getByTestId(`sprint-row-${OLD.id}`).textContent).toContain("4 done")
    // A second sprint cannot start while one runs.
    expect((screen.getByTestId(`sprint-start-${NEXT.id}`) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByTestId("sprint-name-input"), { target: { value: "  Sprint 3 " } })
    fireEvent.click(screen.getByTestId("sprint-create"))
    await waitFor(() => expect(sprintApi.createSprint).toHaveBeenCalledWith({ name: "Sprint 3", goal: null, startsAt: null, endsAt: null }))
  })

  it("completes the active sprint, carrying unfinished Todos into the next planned sprint and starting it", async () => {
    sprintApi.completeSprint.mockResolvedValue({
      sprint: { ...ACTIVE, status: "closed" },
      carried: ["PLA-1", "PLA-2", "PLA-3"],
      carriedTo: { ...NEXT, status: "active" },
    })
    const { onShowOnBoard } = renderDialog()
    fireEvent.click(await screen.findByTestId(`sprint-complete-${ACTIVE.id}`))
    const panel = screen.getByTestId("sprint-complete-panel")
    expect(panel.textContent).toContain("3 unfinished Todos will move to:")
    expect((screen.getByRole("radio", { name: /Sprint 2/ }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByTestId("sprint-complete-confirm"))
    await waitFor(() => expect(sprintApi.completeSprint).toHaveBeenCalledWith(ACTIVE.id, { carryTo: NEXT.id, startNext: true }))
    await waitFor(() => expect(onShowOnBoard).toHaveBeenCalledWith(NEXT.id))
  })

  it("can carry unfinished work into a sprint it creates on the spot, or out of any sprint", async () => {
    sprintApi.createSprint.mockResolvedValue({ sprint: sprint({ id: "spr_ffffffffffff", name: "Hotfix week" }) })
    sprintApi.completeSprint.mockResolvedValue({ sprint: { ...ACTIVE, status: "closed" }, carried: [], carriedTo: null })
    renderDialog({ completing: ACTIVE.id })
    await screen.findByTestId("sprint-complete-panel")
    fireEvent.click(screen.getByRole("radio", { name: /A new sprint/ }))
    fireEvent.change(screen.getByTestId("sprint-carry-new-name"), { target: { value: "Hotfix week" } })
    fireEvent.click(screen.getByTestId("sprint-start-next")) // leave it planned
    fireEvent.click(screen.getByTestId("sprint-complete-confirm"))
    await waitFor(() => expect(sprintApi.createSprint).toHaveBeenCalledWith({ name: "Hotfix week" }))
    await waitFor(() => expect(sprintApi.completeSprint).toHaveBeenCalledWith(ACTIVE.id, { carryTo: "spr_ffffffffffff", startNext: false }))
  })

  it("shows the gateway's refusal instead of closing", async () => {
    sprintApi.completeSprint.mockRejectedValue(new Error("only the active sprint can be completed"))
    renderDialog({ completing: ACTIVE.id })
    await screen.findByTestId("sprint-complete-panel")
    fireEvent.click(screen.getByRole("radio", { name: /No sprint/ }))
    fireEvent.click(screen.getByTestId("sprint-complete-confirm"))
    await waitFor(() => expect(sprintApi.completeSprint).toHaveBeenCalledWith(ACTIVE.id, { carryTo: null, startNext: false }))
    expect(await screen.findByTestId("sprints-error")).toBeTruthy()
    expect(screen.getByTestId("sprint-complete-panel")).toBeTruthy()
  })
})
