import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"

const setTheme = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    getOnboarding: vi.fn().mockResolvedValue({ onboarded: true, needed: false }),
    getFeatures: vi.fn().mockResolvedValue({ notesEnabled: false }),
  },
}))

vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({ settings: {} }),
}))

vi.mock("@/routes/providers", () => ({
  useTheme: () => ({ theme: "dark", setTheme }),
}))

vi.mock("@/hooks/use-workspaces", () => ({
  useWorkspaces: () => ({ data: [] }),
  useStartWorkspace: () => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined }),
}))

import { PageLayout } from "../page-layout"

function renderPage() {
  localStorage.setItem("jinn-onboarded", "true")
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos"]}>
        <PageLayout>
          <div>Page content</div>
        </PageLayout>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("StatusBar in PageLayout", () => {
  it("hosts the workspace switcher and the theme toggle, in that order, inside <main>", () => {
    const { container } = renderPage()

    const main = container.querySelector("main")
    expect(main).toBeTruthy()

    const workspace = within(main!).getByLabelText("Switch workspace")
    const theme = within(main!).getByLabelText(/Theme:/)
    expect(workspace.parentElement).toBe(theme.parentElement)
    expect(workspace.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("is tint only: nothing scrolls beneath a flow sibling, so it takes no blur", () => {
    const { container } = renderPage()

    const bar = within(container.querySelector("main")!).getByLabelText(/Theme:/).parentElement!
    expect(bar.classList.contains("glass-tint-bar")).toBe(true)
    expect(bar.className).not.toMatch(/glass-float|backdrop/)
  })

  it("still cycles the theme from the bar", () => {
    renderPage()

    fireEvent.click(screen.getByLabelText("Theme: dark"))

    expect(setTheme).toHaveBeenCalledWith("light")
  })

  it("keeps both controls out of the primary nav", () => {
    renderPage()

    for (const nav of screen.getAllByRole("navigation", { name: "Primary" })) {
      expect(within(nav).queryByLabelText("Switch workspace")).toBeNull()
      expect(within(nav).queryByLabelText(/Theme:/)).toBeNull()
    }
  })
})
