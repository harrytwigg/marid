import "@/test/preload-menus"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

describe("radio item indicator", () => {
  it("draws the checked item as a solid dot, not a hairline ring", async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="a">
            <DropdownMenuRadioItem value="a">A</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="b">B</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    )

    await userEvent.click(screen.getByRole("button", { name: "Open" }))
    await screen.findByRole("menu")
    const checked = screen.getByRole("menuitemradio", { name: "A" })
    const unchecked = screen.getByRole("menuitemradio", { name: "B" })
    expect(checked.querySelector('[data-icon="CircleIcon"] > path')?.getAttribute("opacity")).toBe("1")
    expect(unchecked.querySelector("svg")).toBeNull()
  })
})
