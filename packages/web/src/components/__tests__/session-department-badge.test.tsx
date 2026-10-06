import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { SessionDepartmentBadge } from "../session-department-badge"

describe("SessionDepartmentBadge", () => {
  it("shows the department a session is bound to", () => {
    render(<SessionDepartmentBadge department="side-project" />)
    const badge = screen.getByTestId("session-department-badge")
    expect(badge.textContent).toBe("side-project")
    expect(badge.getAttribute("title")).toBe("Bound to department side-project: this session works only inside it")
  })

  it.each([null, undefined, ""])("renders nothing for %j", (department) => {
    const { container } = render(<SessionDepartmentBadge department={department} />)
    expect(container.innerHTML).toBe("")
  })
})
