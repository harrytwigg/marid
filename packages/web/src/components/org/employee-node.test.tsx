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

const renderNode = (overrides: Record<string, unknown> = {}) =>
  render(<EmployeeNode {...({ data: { ...employee, ...overrides }, selected: false } as unknown as NodeProps)} />)

describe("EmployeeNode", () => {
  it("gives the name its own row, wrapping rather than ellipsising, with the full name on hover", () => {
    renderNode()
    const name = screen.getByTestId("employee-node-name")
    expect(name.textContent).toBe("Senior Developer Reviewer")
    expect(name.getAttribute("title")).toBe("Senior Developer Reviewer")
    expect(name.className).toContain("line-clamp-2")
    expect(name.className).not.toContain("whitespace-nowrap")
  })

  it("keeps the engine badge from shrinking so it never clips", () => {
    renderNode()
    const badge = screen.getByText("opencode")
    expect(badge.className).toContain("shrink-0")
    expect(badge.className).toContain("whitespace-nowrap")
  })

  it("falls back to the employee's name without a display name", () => {
    renderNode({ displayName: undefined })
    expect(screen.getByTestId("employee-node-name").textContent).toBe("senior-developer")
  })
})
