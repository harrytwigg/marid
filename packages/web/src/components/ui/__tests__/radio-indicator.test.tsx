import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

describe("radio item indicator", () => {
  it("draws the checked item as a solid dot, not a hairline ring", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="a">
            <DropdownMenuRadioItem value="a">A</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="b">B</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    )

    const checked = screen.getByRole("menuitemradio", { name: "A" })
    const unchecked = screen.getByRole("menuitemradio", { name: "B" })
    expect(checked.querySelector('[data-icon="CircleIcon"] > path')?.getAttribute("opacity")).toBe("1")
    expect(unchecked.querySelector("svg")).toBeNull()
  })
})
