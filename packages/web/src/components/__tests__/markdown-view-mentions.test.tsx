import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { TodoPrefixContext } from "@/components/chat/todo-prefix-context"
import { MarkdownView } from "@/components/markdown-view"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: { ...actual.api, getWorkItems: () => Promise.resolve({ workItems: [] }) },
  }
})

const LIVE_PREFIXES: ReadonlySet<string> = new Set(["ISS"])

function renderDocument(content: string, prefixes: ReadonlySet<string> = LIVE_PREFIXES) {
  return render(
    <MemoryRouter initialEntries={["/todos/ISS-1"]}>
      <TodoPrefixContext.Provider value={prefixes}>
        <MarkdownView content={content} isDark={false} mentions />
      </TodoPrefixContext.Provider>
    </MemoryRouter>,
  )
}

describe("Todo mentions in a rendered markdown document", () => {
  it("links a live id in a body or a comment", () => {
    renderDocument("Depends on ISS-740, which is merged.")

    const link = screen.getByRole("link", { name: "ISS-740" })
    expect(link.getAttribute("href")).toBe("/todos/ISS-740")
    expect(screen.getByText(/Depends on/).textContent).toBe("Depends on ISS-740, which is merged.")
  })

  it("links a live id nested in emphasis, a list and a table cell", () => {
    renderDocument([
      "- **ISS-741** in a list",
      "",
      "| Ticket | Note |",
      "| --- | --- |",
      "| ISS-742 | in a cell |",
    ].join("\n"))

    expect(screen.getByRole("link", { name: "ISS-741" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "ISS-742" })).toBeTruthy()
  })

  it("leaves an id alone inside inline code, a fenced block and an existing link", () => {
    const { container } = renderDocument([
      "Inline `ISS-743` stays code.",
      "",
      "```",
      "ISS-744",
      "```",
      "",
      "[ISS-745](https://example.com/x) is already a link.",
    ].join("\n"))

    expect(screen.queryByRole("link", { name: "ISS-743" })).toBeNull()
    expect(screen.queryByRole("link", { name: "ISS-744" })).toBeNull()
    expect(container.querySelector("code")?.textContent).toBe("ISS-743")
    expect(screen.getByRole("link", { name: "ISS-745" }).getAttribute("href"))
      .toBe("https://example.com/x")
  })

  it("leaves a live id alone in a document that did not opt in", () => {
    const prose = "A skill, a note, a file and a workflow's output all say ISS-747 plainly."
    const { container } = render(
      <MemoryRouter initialEntries={["/todos/ISS-1"]}>
        <TodoPrefixContext.Provider value={LIVE_PREFIXES}>
          <MarkdownView content={prose} isDark={false} />
        </TodoPrefixContext.Provider>
      </MemoryRouter>,
    )

    expect(container.querySelector("a")).toBeNull()
    expect(screen.getByText(/A skill/).textContent).toBe(prose)
  })

  it("leaves an id from an unknown prefix as the text it was", () => {
    const { container } = renderDocument("GPT-5 and SHA-256 and ZZZ-746 are not Todos.")

    expect(container.querySelector("a")).toBeNull()
    expect(screen.getByText(/GPT-5/).textContent).toBe("GPT-5 and SHA-256 and ZZZ-746 are not Todos.")
  })

  it("renders a document with no mention in it byte-identically", () => {
    const document = "# Heading\n\nA paragraph with **bold**, `code`, and a [link](https://example.com).\n"
    const withoutProvider = render(<MarkdownView content={document} isDark={false} />)
    const before = withoutProvider.container.innerHTML
    withoutProvider.unmount()

    const { container } = renderDocument(document)

    expect(container.innerHTML).toBe(before)
  })
})
