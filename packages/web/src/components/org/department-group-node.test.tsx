import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { NodeProps } from "@xyflow/react"
import { DepartmentGroupNode } from "./employee-node"

const render_ = (data: Record<string, unknown>) => render(<DepartmentGroupNode {...({ data } as unknown as NodeProps)} />)

describe("DepartmentGroupNode", () => {
  it("shows the scope badge beside the department's name", () => {
    render_({ label: "side-project", scope: "scoped" })
    expect(screen.getByTestId("department-group-side-project").textContent).toBe("side-projectScoped")
    expect(screen.getByTestId("department-scope-badge").getAttribute("data-scope")).toBe("scoped")
  })

  it("shows none for an open department", () => {
    render_({ label: "engineering" })
    expect(screen.queryByTestId("department-scope-badge")).toBeNull()
    expect(screen.getByTestId("department-group-engineering").textContent).toBe("engineering")
  })
})
