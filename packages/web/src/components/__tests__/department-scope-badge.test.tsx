import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { DepartmentScopeBadge } from "../department-scope-badge"

describe("DepartmentScopeBadge", () => {
  it.each([
    ["scoped", "Scoped"],
    ["dedicated", "Dedicated"],
  ] as const)("names a %s department", (scope, text) => {
    render(<DepartmentScopeBadge scope={scope} />)
    const badge = screen.getByTestId("department-scope-badge")
    expect(badge.textContent).toBe(text)
    expect(badge.getAttribute("data-scope")).toBe(scope)
    expect(badge.getAttribute("title")).toMatch(/work only inside this department/)
  })

  it.each([["open"], [undefined]] as const)("shows nothing for %s, so an instance with no department.yaml looks as it did", (scope) => {
    const { container } = render(<DepartmentScopeBadge scope={scope} />)
    expect(container.firstChild).toBeNull()
  })
})
