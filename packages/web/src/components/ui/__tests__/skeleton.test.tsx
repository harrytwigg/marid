import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Skeleton } from "../skeleton"

describe("Skeleton", () => {
  it("is HeroUI's skeleton, sized by width and height", () => {
    const { container } = render(<Skeleton width={120} height="1.5rem" className="mine" data-testid="s" />)
    const skeleton = container.firstElementChild as HTMLElement

    expect(skeleton.className).toContain("skeleton")
    expect(skeleton.className).toContain("mine")
    expect(skeleton.style.width).toBe("120px")
    expect(skeleton.style.height).toBe("1.5rem")
    expect(skeleton.getAttribute("data-testid")).toBe("s")
  })

  it("keeps the caller's own style on top of the size", () => {
    const { container } = render(<Skeleton width={10} style={{ width: 50, opacity: 0.5 }} />)
    const skeleton = container.firstElementChild as HTMLElement

    expect(skeleton.style.width).toBe("50px")
    expect(skeleton.style.opacity).toBe("0.5")
  })
})
