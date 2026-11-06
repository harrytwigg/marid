import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createBrowserGatewayTransport, installGatewayTransport } from "@/lib/gateway-transport"

/** A browser holding a member's session gets 403 from the public account routes, so /invite and /reset
 *  must offer the way out before they try to use the link. */
const inspectInvite = vi.fn()
const inspectReset = vi.fn()
vi.mock("@/lib/accounts-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/accounts-api")>("@/lib/accounts-api")
  return {
    ...actual,
    accountsApi: { ...actual.accountsApi, inspectInvite: (...a: unknown[]) => inspectInvite(...a), inspectReset: (...a: unknown[]) => inspectReset(...a) },
  }
})

import InvitePage from "./invite-page"
import ResetPage from "./reset-page"

const member = { kind: "member", user: { id: "u1", email: "mia@example.test", displayName: "Mia Member" }, boards: [] }
let principal: unknown = member
let stateFails = false
let logoutFails = false
const requests: string[] = []
let restore: () => void

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

beforeEach(() => {
  principal = member
  stateFails = false
  logoutFails = false
  requests.length = 0
  inspectInvite.mockReset().mockResolvedValue({ email: "new@example.test", boardName: "Design", role: "collaborator", invitedBy: "Alex" })
  inspectReset.mockReset().mockResolvedValue({ email: "new@example.test", displayName: "New Person" })
  restore = installGatewayTransport(createBrowserGatewayTransport({
    origin: "http://gateway.test",
    navigate: vi.fn(),
    request: async (input) => {
      const path = new URL(input).pathname
      requests.push(path)
      if (path === "/api/auth/state") return stateFails ? json({}, 500) : json({ authRequired: true, authenticated: true, accountsEnabled: true, hasAccounts: true, principal })
      if (path === "/api/auth/logout") {
        if (logoutFails) return json({ error: "no" }, 500)
        principal = null
        return json({ ok: true })
      }
      return json({})
    },
  }))
})

afterEach(() => {
  cleanup()
  restore()
  window.history.replaceState(null, "", "/")
})

const PAGES = [
  ["invite", "/invite#tok-123", InvitePage, () => inspectInvite, /accept invite/i],
  ["reset", "/reset#tok-123", ResetPage, () => inspectReset, /reset|password/i],
] as const

describe.each(PAGES)("the %s page for a signed-in member", (_name, url, Page, inspect) => {
  it("names them, offers sign out, and does not touch the link", async () => {
    window.history.replaceState(null, "", url)
    render(<Page />)
    expect(await screen.findByTestId("signed-in-notice")).toBeTruthy()
    expect(screen.getByText(/signed in as Mia Member\. Sign out to continue/)).toBeTruthy()
    expect(screen.queryByRole("form")).toBeNull()
    expect(inspect()).not.toHaveBeenCalled()
    // The token is out of the address at once, and held for after sign-out.
    expect(window.location.hash).toBe("")
  })

  it("signs out through the gateway, then runs the link with its token", async () => {
    window.history.replaceState(null, "", url)
    render(<Page />)
    fireEvent.click(await screen.findByTestId("signed-in-sign-out"))
    await waitFor(() => expect(inspect()).toHaveBeenCalledWith("tok-123"))
    expect(requests).toContain("/api/auth/logout")
    expect(screen.queryByTestId("signed-in-notice")).toBeNull()
  })

  it("stays on the notice, and says so, when sign out fails", async () => {
    logoutFails = true
    window.history.replaceState(null, "", url)
    render(<Page />)
    fireEvent.click(await screen.findByTestId("signed-in-sign-out"))
    expect(await screen.findByText(/couldn.t sign out/i)).toBeTruthy()
    expect(inspect()).not.toHaveBeenCalled()
    expect(screen.getByTestId("signed-in-sign-out").hasAttribute("disabled")).toBe(false)
  })

  it("is not in the way of anyone who is not signed in as a member", async () => {
    principal = null
    window.history.replaceState(null, "", url)
    render(<Page />)
    await waitFor(() => expect(inspect()).toHaveBeenCalledWith("tok-123"))
    expect(screen.queryByTestId("signed-in-notice")).toBeNull()
  })

  it("carries on as before when the gateway cannot say who is signed in", async () => {
    stateFails = true
    window.history.replaceState(null, "", url)
    render(<Page />)
    await waitFor(() => expect(inspect()).toHaveBeenCalledWith("tok-123"))
    expect(screen.queryByTestId("signed-in-notice")).toBeNull()
  })
})
