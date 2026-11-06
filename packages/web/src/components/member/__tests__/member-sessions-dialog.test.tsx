import "@/test/preload-dialogs"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AccountsError } from "@/lib/accounts-api"

const listMemberSessions = vi.fn()
const revokeMemberSession = vi.fn()
vi.mock("@/lib/accounts-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/accounts-api")>("@/lib/accounts-api")
  return { ...actual, accountsApi: { ...actual.accountsApi, listMemberSessions: (...a: unknown[]) => listMemberSessions(...a), revokeMemberSession: (...a: unknown[]) => revokeMemberSession(...a) } }
})
vi.mock("@/routes/auth-provider", () => ({ useAuth: () => ({ refresh: vi.fn() }) }))

import { MemberSessionsDialog } from "../member-sessions-dialog"

beforeEach(() => {
  listMemberSessions.mockReset().mockResolvedValue([
    { id: "s1", kind: "member", createdAt: "2026-11-01T00:00:00Z", lastSeenAt: "2026-11-06T09:00:00Z", userAgent: "Firefox", ip: null, current: true },
    { id: "s2", kind: "member", createdAt: "2026-11-01T00:00:00Z", lastSeenAt: null, userAgent: "Phone", ip: null, current: false },
  ])
  revokeMemberSession.mockReset()
})

function open() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemberSessionsDialog onClose={() => {}} />
    </QueryClientProvider>,
  )
}

describe("the member's sessions dialog", () => {
  it("says so when a revoke fails, so the member does not think the session ended", async () => {
    revokeMemberSession.mockRejectedValue(new AccountsError(429, "slow down", 30))
    open()
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }))
    const alert = await screen.findByTestId("revoke-error")
    expect(alert.textContent).toMatch(/too many attempts/i)
  })

  it("says nothing when a revoke works", async () => {
    revokeMemberSession.mockResolvedValue(undefined)
    open()
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }))
    await waitFor(() => expect(revokeMemberSession).toHaveBeenCalledWith("s2"))
    expect(screen.queryByTestId("revoke-error")).toBeNull()
  })
})
