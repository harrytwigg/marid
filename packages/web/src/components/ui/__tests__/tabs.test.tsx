import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs"

function Demo({ onValueChange, variant }: { onValueChange?: (value: string) => void; variant?: "default" | "line" }) {
  return (
    <Tabs defaultValue="a" onValueChange={onValueChange}>
      <TabsList aria-label="Sections" variant={variant}>
        <TabsTrigger value="a">Alpha</TabsTrigger>
        <TabsTrigger value="b">Beta</TabsTrigger>
        <TabsTrigger value="c" disabled>
          Gamma
        </TabsTrigger>
      </TabsList>
      <TabsContent value="a">Alpha panel</TabsContent>
      <TabsContent value="b">Beta panel</TabsContent>
      <TabsContent value="c">Gamma panel</TabsContent>
    </Tabs>
  )
}

describe("Tabs", () => {
  it("shows the selected panel, marks its tab selected, and switches on a click", async () => {
    const onValueChange = vi.fn()
    render(<Demo onValueChange={onValueChange} />)

    expect(screen.getByRole("tab", { name: "Alpha" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByRole("tabpanel").textContent).toBe("Alpha panel")

    await userEvent.click(screen.getByRole("tab", { name: "Beta" }))
    expect(onValueChange).toHaveBeenLastCalledWith("b")
    expect(screen.getByRole("tab", { name: "Beta" }).getAttribute("data-selected")).toBe("true")
    expect(screen.getByRole("tabpanel").textContent).toBe("Beta panel")
  })

  it("moves between tabs with the arrow keys, skipping a disabled one, and Home and End", async () => {
    render(<Demo />)

    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Alpha" }))
    expect(document.activeElement!.getAttribute("data-focus-visible")).toBe("true")

    await userEvent.keyboard("{ArrowRight}")
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Beta" }))
    expect(screen.getByRole("tabpanel").textContent).toBe("Beta panel")

    await userEvent.keyboard("{ArrowRight}")
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Alpha" }))
    await userEvent.keyboard("{End}")
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Beta" }))
    await userEvent.keyboard("{Home}")
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Alpha" }))
  })

  it("does not select a disabled tab", async () => {
    const onValueChange = vi.fn()
    render(<Demo onValueChange={onValueChange} />)

    await userEvent.click(screen.getByRole("tab", { name: "Gamma" }))
    expect(onValueChange).not.toHaveBeenCalled()
    expect(screen.getByRole("tabpanel").textContent).toBe("Alpha panel")
  })

  it("follows `value` when it is controlled", async () => {
    function Controlled() {
      const [value, setValue] = useState("b")
      return (
        <Tabs value={value} onValueChange={setValue}>
          <TabsList aria-label="Sections">
            <TabsTrigger value="a">Alpha</TabsTrigger>
            <TabsTrigger value="b">Beta</TabsTrigger>
          </TabsList>
          <TabsContent value="a">Alpha panel</TabsContent>
          <TabsContent value="b">Beta panel</TabsContent>
        </Tabs>
      )
    }
    render(<Controlled />)

    expect(screen.getByRole("tabpanel").textContent).toBe("Beta panel")
    await userEvent.click(screen.getByRole("tab", { name: "Alpha" }))
    expect(screen.getByRole("tabpanel").textContent).toBe("Alpha panel")
  })

  it("draws the default variant as HeroUI's pill list and `line` as its underline", () => {
    const { container, unmount } = render(<Demo />)
    expect(container.querySelector(".tabs--secondary")).toBeNull()
    unmount()

    const line = render(<Demo variant="line" />)
    expect(line.container.querySelector(".tabs--secondary")).not.toBeNull()
  })

  it("keeps the slots and the extra classes call sites pass", () => {
    render(
      <Tabs defaultValue="a" className="mine">
        <TabsList aria-label="Sections">
          <TabsTrigger value="a" className="trigger">
            Alpha
          </TabsTrigger>
        </TabsList>
        <TabsContent value="a" className="content">
          Alpha panel
        </TabsContent>
      </Tabs>,
    )

    expect(document.querySelector('[data-slot="tabs"]')!.className).toContain("mine")
    expect(screen.getByRole("tab").className).toContain("trigger")
    expect(screen.getByRole("tabpanel").className).toContain("content")
  })

  it("selects the first tab and shows its panel when no defaultValue is given", () => {
    render(
      <Tabs>
        <TabsList aria-label="Sections">
          <TabsTrigger value="a">Alpha</TabsTrigger>
          <TabsTrigger value="b">Beta</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Alpha panel</TabsContent>
        <TabsContent value="b">Beta panel</TabsContent>
      </Tabs>,
    )

    expect(screen.getByRole("tab", { name: "Alpha" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByRole("tabpanel").textContent).toBe("Alpha panel")
  })

  it("shows no panel for a value that matches no tab", () => {
    render(
      <Tabs value="missing">
        <TabsList aria-label="Sections">
          <TabsTrigger value="a">Alpha</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Alpha panel</TabsContent>
      </Tabs>,
    )

    expect(screen.queryByRole("tabpanel")).toBeNull()
  })

  it("carries style and onClick to a trigger, but not a title: React Aria drops it", async () => {
    const onClick = vi.fn()
    const props = { title: "tip", style: { opacity: 0.5 }, onClick } as never
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Sections">
          <TabsTrigger value="a" {...(props as object)}>
            Alpha
          </TabsTrigger>
        </TabsList>
        <TabsContent value="a">Alpha panel</TabsContent>
      </Tabs>,
    )
    const tab = screen.getByRole("tab", { name: "Alpha" })

    await userEvent.click(tab)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(tab.style.opacity).toBe("0.5")
    expect(tab.getAttribute("title")).toBeNull()
  })
})
