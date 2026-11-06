import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

let principal: { kind: string } | null = null
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => ({ principal, authState: { principal } }) }))
vi.mock("@/components/chat/chat-hydration", () => ({ useRouteLoadingPresence: () => {} }))
vi.mock("@/components/chat/mobile-tab-bar", () => ({ MobileTabBar: () => <nav data-testid="mobile-tab-bar" /> }))

import { RouteLoading } from "../route-loading"

describe("RouteLoading", () => {
  it("keeps the operator's tab bar for the operator", () => {
    principal = { kind: "operator" }
    render(<MemoryRouter><RouteLoading /></MemoryRouter>)
    expect(screen.getByTestId("mobile-tab-bar")).toBeTruthy()
  })

  it("never shows a board member the operator's navigation while a page loads", () => {
    principal = { kind: "member" }
    render(<MemoryRouter><RouteLoading /></MemoryRouter>)
    expect(screen.getByRole("status")).toBeTruthy()
    expect(screen.queryByTestId("mobile-tab-bar")).toBeNull()
  })
})
