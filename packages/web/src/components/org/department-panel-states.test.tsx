import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DepartmentPanel } from "./department-panel"

/* The panel before its department has loaded, and when it cannot. */

const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock("@/hooks/use-department", () => ({ useDepartment: () => state.value }))

const show = (value: Record<string, unknown>) => {
  state.value = value
  render(<DepartmentPanel slug="side-project" onSelectEmployee={() => {}} />)
}

describe("DepartmentPanel while it has nothing to show", () => {
  it("says it is loading", () => {
    show({ isLoading: true, isError: false, data: undefined })
    expect(screen.getByText("Loading...")).toBeTruthy()
  })

  it("reports a department that cannot be loaded", () => {
    show({ isLoading: false, isError: true, data: undefined })
    expect(screen.getByRole("alert").textContent).toBe("This department could not be loaded.")
  })
})
