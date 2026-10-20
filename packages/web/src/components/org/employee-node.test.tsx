import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { NodeProps } from "@xyflow/react"
import { EmployeeNode } from "./employee-node"

vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  Handle: () => null,
}))
vi.mock("@/components/ui/employee-avatar", () => ({ EmployeeAvatar: () => null }))

const employee = {
  name: "senior-developer",
  displayName: "Senior Developer Reviewer",
  rank: "employee",
  engine: "opencode",
  model: "deepseek-v4.1-flash",
}

const renderNode = (overrides: Record<string, unknown> = {}, selected = false) =>
  render(<EmployeeNode {...({ data: { ...employee, ...overrides }, selected } as unknown as NodeProps)} />)

describe("EmployeeNode", () => {
  it("shows the whole name, with the full name as the hover title", () => {
    renderNode()
    const name = screen.getByTestId("employee-node-name")
    expect(name.textContent).toBe("Senior Developer Reviewer")
    expect(name.getAttribute("title")).toBe("Senior Developer Reviewer")
  })

  it("falls back to the employee's name without a display name", () => {
    renderNode({ displayName: undefined })
    expect(screen.getByTestId("employee-node-name").textContent).toBe("senior-developer")
  })

  it("shows the engine, and carries the model with its full name on hover", () => {
    renderNode()
    expect(screen.getByText("opencode")).toBeTruthy()
    expect(screen.getByTestId("employee-node-model").textContent).toBe("deepseek-v4.1-flash")
    expect(screen.getByTestId("employee-node-model").getAttribute("title")).toBe("deepseek-v4.1-flash")
  })

  it("leaves out the model line for an employee with no model and no profile", () => {
    renderNode({ model: undefined })
    expect(screen.queryByTestId("employee-node-model")).toBeNull()
  })
})
