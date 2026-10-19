import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Badge } from "../badge"

describe("Badge", () => {
  it.each([
    ["default", "chip--default", "chip--soft"],
    ["secondary", "chip--default", "chip--tertiary"],
    ["success", "chip--success", "chip--soft"],
    ["warning", "chip--warning", "chip--soft"],
    ["destructive", "chip--danger", "chip--soft"],
  ] as const)("draws the %s variant as a HeroUI chip", (variant, color, style) => {
    render(<Badge variant={variant}>Label</Badge>)
    const badge = screen.getByText("Label").closest(".chip")!

    expect(badge.className).toContain("chip")
    expect(badge.className).toContain(color)
    expect(badge.className).toContain(style)
    expect((badge as HTMLElement).dataset.variant).toBe(variant)
  })

  it("keeps a span's props, children and extra classes", () => {
    render(
      <Badge title="Status" data-testid="badge" className="mine">
        <svg data-testid="icon" />
        Done
      </Badge>,
    )
    const badge = screen.getByTestId("badge")

    expect(badge.tagName).toBe("SPAN")
    expect(badge.getAttribute("title")).toBe("Status")
    expect(badge.className).toContain("mine")
    expect(badge.querySelector('[data-testid="icon"]')).not.toBeNull()
    expect(badge.textContent).toBe("Done")
  })

  it("lets asChild put the chip's look on another element", () => {
    render(
      <Badge asChild variant="success">
        <a href="/done">Done</a>
      </Badge>,
    )
    const link = screen.getByRole("link", { name: "Done" })

    expect(link.className).toContain("chip--success")
    expect(link.dataset.slot).toBe("badge")
    expect(link.dataset.variant).toBe("success")
  })
})
