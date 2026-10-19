import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { CloseTodosBadge } from "@/components/org/close-todos-badge"

describe("CloseTodosBadge", () => {
  it("shows the badge for an employee granted closeTodos, with where the grant lives on hover", () => {
    render(<CloseTodosBadge closeTodos />)
    const badge = screen.getByTestId("close-todos-badge")
    expect(badge.textContent).toBe("Can close Todos")
    expect(badge.getAttribute("title")).toMatch(/closeTodos in its YAML/)
  })

  it("shows nothing when the grant is absent or false", () => {
    const { container } = render(<><CloseTodosBadge closeTodos={undefined} /><CloseTodosBadge closeTodos={false} /></>)
    expect(container.innerHTML).toBe("")
  })
})
