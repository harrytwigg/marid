import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import type { DepartmentRowWire } from "@/lib/department-api"
import { BoardSwitcher } from "../board/board-switcher"

/* The scope badge on the board switcher's department rows. Open departments, and a
 * gateway too old to send a scope, show none. */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { listWorkItems: vi.fn(async () => ({ workItems: [], totals: {} })) } }
})

const rows: DepartmentRowWire[] = [
  { slug: "engineering", prefix: "ENG", createdAt: "2026-07-01", todoCount: 3, scope: "open" },
  { slug: "side-project", prefix: "SID", createdAt: "2026-07-01", todoCount: 0, scope: "scoped" },
  { slug: "friend-lab", prefix: "FRI", createdAt: "2026-07-01", todoCount: 1, scope: "dedicated" },
  { slug: "legacy", prefix: "LEG", createdAt: "2026-07-01", todoCount: 1 },
]

async function openMenu() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/todos/b/everything"]}>
        <BoardSwitcher board={{ kind: "everything" }} title="Everything" departments={rows} attentionCount={0} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const trigger = await screen.findByTestId("board-switcher")
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" })
  fireEvent.click(trigger)
  await waitFor(() => expect(screen.getByTestId("board-menu-attention")).toBeTruthy())
}

describe("the switcher's department rows", () => {
  it("badge a scoped and a dedicated department, and no other", async () => {
    await openMenu()
    const badgeOf = (slug: string) => within(screen.getByTestId(`board-menu-${slug}`)).queryByTestId("department-scope-badge")
    expect(badgeOf("side-project")?.textContent).toBe("Scoped")
    expect(badgeOf("friend-lab")?.textContent).toBe("Dedicated")
    expect(badgeOf("engineering")).toBeNull()
    expect(badgeOf("legacy")).toBeNull()
  })

  it("keep the prefix, the title and the badge on one row, in that order", async () => {
    await openMenu()
    const row = screen.getByTestId("board-menu-side-project")
    expect(row.textContent).toMatch(/^SIDSide ProjectScoped/)
  })
})
