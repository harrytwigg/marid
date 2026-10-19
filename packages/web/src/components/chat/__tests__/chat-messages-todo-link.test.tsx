import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import { describe, expect, it } from "vitest"
import { TodoPrefixContext } from "../todo-prefix-context"
import { formatMessage } from "../chat-messages"
import { FileLinkSessionContext } from "../file-link-session-context"

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderMessage(content: string, prefixes: ReadonlySet<string>) {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <TodoPrefixContext.Provider value={prefixes}>
        <div data-testid="message">{formatMessage(content)}</div>
        <LocationProbe />
      </TodoPrefixContext.Provider>
    </MemoryRouter>,
  )
}

describe("Todo links in chat messages", () => {
  it("renders a live bare Todo ID as a relative in-app link", () => {
    renderMessage("Open ISS-637", new Set(["ISS"]))

    const link = screen.getByRole("link", { name: "ISS-637" })
    expect(link.getAttribute("href")).toBe("/todos/ISS-637")
    expect(link.outerHTML).not.toContain("://")

    fireEvent.click(link)
    expect(screen.getByTestId("location").textContent).toBe("/todos/ISS-637")
  })

  it("renders a backticked live Todo ID as the same link instead of code", () => {
    const { container } = renderMessage("Check `TSK-18`", new Set(["TSK"]))

    expect(screen.getByRole("link", { name: "TSK-18" }).getAttribute("href")).toBe("/todos/TSK-18")
    expect(container.querySelector("code")).toBeNull()
  })

  it("leaves non-live prefixes byte-identical as plain text", () => {
    renderMessage("GPT-5 SHA-256 UTF-8", new Set(["ISS", "TSK"]))

    expect(screen.getByTestId("message").textContent).toBe("GPT-5 SHA-256 UTF-8")
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("leaves Todo-shaped text unlinked without a provider", () => {
    const { container } = render(<div>{formatMessage("ISS-637")}</div>)

    expect(container.textContent).toBe("ISS-637")
    expect(container.querySelector("a")).toBeNull()
  })

  it("preserves the inline-code chip for a backticked ID without a live prefix", () => {
    const { container } = render(<div>{formatMessage("`ISS-637`")}</div>)

    expect(container.querySelector("code")?.textContent).toBe("ISS-637")
    expect(container.querySelector("a")).toBeNull()
  })

  it("does not link IDs inside URLs, fenced code, or shape-adjacent junk", () => {
    const content = [
      "https://example.test/todos/ISS-637",
      "```text",
      "ISS-637",
      "```",
      "XISS-637 ISS-637-2 ISS-5.6 ISS-0",
    ].join("\n")
    const { container } = renderMessage(content, new Set(["ISS"]))

    const links = screen.getAllByRole("link")
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute("href")).toBe("https://example.test/todos/ISS-637")
    expect(container.querySelector("pre code")?.textContent).toBe("ISS-637")
    expect(screen.getByTestId("message").textContent).toContain("XISS-637 ISS-637-2 ISS-5.6 ISS-0")
  })

  it("renders a live Todo ID inside bold text", () => {
    const { container } = renderMessage("**TSK-40**", new Set(["TSK"]))

    const strong = container.querySelector("strong")
    const link = screen.getByRole("link", { name: "TSK-40" })
    expect(link.getAttribute("href")).toBe("/todos/TSK-40")
    expect(strong?.contains(link)).toBe(true)
  })

  it("preserves surrounding bold text around a live Todo ID", () => {
    const { container } = renderMessage("**Dispatched — TSK-40, three commits**", new Set(["TSK"]))

    const strong = container.querySelector("strong")
    const link = screen.getByRole("link", { name: "TSK-40" })
    expect(link.getAttribute("href")).toBe("/todos/TSK-40")
    expect(strong?.contains(link)).toBe(true)
    expect(strong?.textContent).toBe("Dispatched — TSK-40, three commits")
  })

  it("renders a live Todo ID inside italic text", () => {
    const { container } = renderMessage("*ISS-637*", new Set(["ISS"]))

    const emphasis = container.querySelector("em")
    const link = screen.getByRole("link", { name: "ISS-637" })
    expect(link.getAttribute("href")).toBe("/todos/ISS-637")
    expect(emphasis?.contains(link)).toBe(true)
  })

  it("keeps non-live Todo-shaped text plain inside bold text", () => {
    const { container } = renderMessage("**GPT-5 SHA-256**", new Set(["ISS", "TSK"]))

    const strong = container.querySelector("strong")
    expect(strong?.textContent).toBe("GPT-5 SHA-256")
    expect(strong?.querySelector("a")).toBeNull()
  })

  it("renders a backticked live Todo ID as a link inside bold text", () => {
    const { container } = renderMessage("**Check `TSK-18`**", new Set(["TSK"]))

    const strong = container.querySelector("strong")
    const link = screen.getByRole("link", { name: "TSK-18" })
    expect(link.getAttribute("href")).toBe("/todos/TSK-18")
    expect(strong?.contains(link)).toBe(true)
    expect(strong?.querySelector("code")).toBeNull()
  })

  it("renders a file-viewer link inside bold text", () => {
    const { container } = render(
      <FileLinkSessionContext.Provider value="s-1">{formatMessage("**src/index.ts**")}</FileLinkSessionContext.Provider>,
    )

    const strong = container.querySelector("strong")
    const link = screen.getByRole("link", { name: "src/index.ts" })
    expect(link.getAttribute("href")).toBe("/file?path=src%2Findex.ts&session=s-1")
    expect(strong?.contains(link)).toBe(true)
  })

  it("preserves unlinked bold text and its existing element", () => {
    const { container } = renderMessage("**bold**", new Set(["ISS", "TSK"]))

    const strong = container.querySelector("strong")
    expect(strong?.outerHTML).toBe('<strong class="font-[var(--weight-bold)]">bold</strong>')
  })
})
