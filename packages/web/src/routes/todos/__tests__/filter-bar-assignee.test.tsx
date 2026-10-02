import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render as rtlRender, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Employee } from "@/lib/api"
import { activeFilterCount, filtersFromSearchParams, filtersToSearchParams } from "@/lib/todos"
import { FilterBar } from "../filter-bar"
import { assigneeFilterLabel, OPERATOR_ASSIGNEE, UNASSIGNED_FILTER } from "../util"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { ...actual.api, listLabels: vi.fn().mockResolvedValue({ labels: [] }) } }
})

function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = (node: React.ReactElement) => <QueryClientProvider client={client}>{node}</QueryClientProvider>
  const result = rtlRender(wrap(ui))
  return { ...result, rerender: (next: React.ReactElement) => result.rerender(wrap(next)) }
}

const originalMatchMedia = window.matchMedia
function setMobile(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 767px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

afterEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia })
})

const employee = { name: "some-employee", displayName: "Some Employee", department: "platform" } as Employee
const byName = new Map([[employee.name, employee]])

function openAssigneeChip() {
  const chip = screen.getByTestId("filter-chip-assignee")
  fireEvent.pointerDown(chip, { button: 0, pointerType: "mouse" })
  fireEvent.click(chip)
}

describe("the Assignee filter offers the operator and Unassigned", () => {
  it("labels the operator and no-assignee values, and passes other names through", () => {
    expect(assigneeFilterLabel(undefined, byName)).toBeNull()
    expect(assigneeFilterLabel(OPERATOR_ASSIGNEE, byName)).toBe("Assigned to me")
    expect(assigneeFilterLabel(UNASSIGNED_FILTER, byName)).toBe("Unassigned")
    expect(assigneeFilterLabel("some-employee", byName)).toBe("Some Employee")
    expect(assigneeFilterLabel("gone-employee", byName)).toBe("gone-employee")
  })

  it("the board chip lists Anyone, Assigned to me and Unassigned ahead of the roster", async () => {
    setMobile(false)
    render(<FilterBar filters={{ status: "open" }} onChange={vi.fn()} employees={[employee]} departments={[]} byName={byName} hideStatus board />)
    openAssigneeChip()
    const labels = (await screen.findAllByRole("menuitem")).map((item) => item.textContent)
    expect(labels.slice(0, 3)).toEqual(["Anyone", "Assigned to me", "Unassigned"])
    expect(labels).toHaveLength(4)
    expect(labels[3]).toContain("Some Employee")
  })

  it("selecting Assigned to me sets the operator assignee and the chip reads it", () => {
    setMobile(false)
    const onChange = vi.fn()
    const { rerender } = render(
      <FilterBar filters={{ status: "open" }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} hideStatus board />,
    )
    openAssigneeChip()
    fireEvent.click(screen.getByText("Assigned to me"))
    expect(onChange).toHaveBeenCalledWith({ status: "open", assignee: OPERATOR_ASSIGNEE, q: undefined })
    rerender(
      <FilterBar filters={{ status: "open", assignee: OPERATOR_ASSIGNEE }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} hideStatus board />,
    )
    expect(screen.getByTestId("filter-chip-assignee").textContent).toContain("Assigned to me")
  })

  it("selecting Unassigned sets the sentinel and the chip reads it", () => {
    setMobile(false)
    const onChange = vi.fn()
    const { rerender } = render(
      <FilterBar filters={{ status: "open" }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} hideStatus board />,
    )
    openAssigneeChip()
    fireEvent.click(screen.getByText("Unassigned"))
    expect(onChange).toHaveBeenCalledWith({ status: "open", assignee: UNASSIGNED_FILTER, q: undefined })
    rerender(
      <FilterBar filters={{ status: "open", assignee: UNASSIGNED_FILTER }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} hideStatus board />,
    )
    expect(screen.getByTestId("filter-chip-assignee").textContent).toContain("Unassigned")
  })

  it.each([
    ["Assigned to me", OPERATOR_ASSIGNEE],
    ["Unassigned", UNASSIGNED_FILTER],
  ])("%s clears back to Anyone from the board chip", (_label, assignee) => {
    setMobile(false)
    const onChange = vi.fn()
    render(
      <FilterBar filters={{ status: "open", assignee }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} hideStatus board />,
    )
    openAssigneeChip()
    fireEvent.click(screen.getByText("Anyone"))
    expect(onChange).toHaveBeenCalledWith({ status: "open", assignee: undefined, q: undefined })
  })

  it.each([
    ["Assigned to me", OPERATOR_ASSIGNEE],
    ["Unassigned", UNASSIGNED_FILTER],
  ])("the active-filter chip for %s is removable", (label, assignee) => {
    setMobile(false)
    const onChange = vi.fn()
    render(
      <FilterBar filters={{ status: "open", assignee }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} />,
    )
    expect(screen.getByLabelText("Active filters").textContent).toContain(`Person: ${label}`)
    fireEvent.click(screen.getByRole("button", { name: `Remove Person: ${label}` }))
    expect(onChange).toHaveBeenCalledWith({ status: "open", assignee: undefined, q: undefined })
  })

  it("the mobile Person panel offers both choices and the root row reads the current one", () => {
    setMobile(true)
    const onChange = vi.fn()
    const { rerender } = render(
      <FilterBar filters={{ status: "open" }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Filter todos" }))
    fireEvent.click(screen.getByRole("button", { name: "Person" }))
    fireEvent.click(screen.getByRole("button", { name: /^Assigned to me/ }))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", assignee: OPERATOR_ASSIGNEE, q: undefined })

    rerender(
      <FilterBar filters={{ status: "open", assignee: OPERATOR_ASSIGNEE }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} />,
    )
    expect(screen.getByRole("button", { name: "Person" }).textContent).toContain("Assigned to me")
    fireEvent.click(screen.getByRole("button", { name: "Person" }))
    fireEvent.click(screen.getByRole("button", { name: /^Unassigned/ }))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", assignee: UNASSIGNED_FILTER, q: undefined })

    rerender(
      <FilterBar filters={{ status: "open", assignee: UNASSIGNED_FILTER }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Person" }))
    fireEvent.click(screen.getByRole("button", { name: /^Anyone/ }))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", assignee: undefined, q: undefined })
  })

  it("both values count as an active filter and survive the URL round trip", () => {
    for (const assignee of [OPERATOR_ASSIGNEE, UNASSIGNED_FILTER]) {
      const filters = { status: "open" as const, assignee }
      expect(activeFilterCount(filters)).toBe(1)
      expect(filtersFromSearchParams(filtersToSearchParams(filters))).toEqual(filters)
    }
  })
})
