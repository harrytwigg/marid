import { StrictMode, Suspense } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import { createBrowserGatewayTransport, installGatewayTransport } from "@/lib/gateway-transport"

/** React may run a state initializer more than once for one mount (StrictMode, or a render that suspends and
 *  is replayed). The page reads the link's token out of the address bar in one, so a second run must not
 *  lose it: a person opening a good link must not be told it has expired. */
const inspectInvite = vi.fn()
const inspectReset = vi.fn()
vi.mock("@/lib/accounts-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/accounts-api")>("@/lib/accounts-api")
  return { ...actual, accountsApi: { ...actual.accountsApi, inspectInvite: (...a: unknown[]) => inspectInvite(...a), inspectReset: (...a: unknown[]) => inspectReset(...a) } }
})

import { forgetFragmentToken, takeFragmentToken } from "@/lib/accounts-api"
import InvitePage from "./invite-page"
import ResetPage from "./reset-page"

let restore: () => void

beforeEach(() => {
  forgetFragmentToken()
  inspectInvite.mockReset().mockResolvedValue({ email: "a@example.test", boardName: "Design", role: "viewer", invitedBy: "Alex" })
  inspectReset.mockReset().mockResolvedValue({ email: "a@example.test", displayName: "A" })
  restore = installGatewayTransport(createBrowserGatewayTransport({
    origin: "http://gateway.test",
    navigate: vi.fn(),
    request: async () => new Response(JSON.stringify({ authRequired: true, authenticated: false }), { headers: { "Content-Type": "application/json" } }),
  }))
})

afterEach(() => {
  cleanup()
  forgetFragmentToken()
  restore()
  window.history.replaceState(null, "", "/")
})

/** Suspends on its first render only. While it does, the boundary holds back everything beside it, and on the retry
 *  those siblings render again from nothing, so their state initializers run a second time. */
function SuspendsOnce() {
  if (!suspended) {
    suspended = true
    throw new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  return null
}
let suspended = false

describe("a link's token survives a replayed render", () => {
  it("returns the same token on a second read of the same page load", () => {
    window.history.replaceState(null, "", "/invite#good")
    expect(takeFragmentToken()).toBe("good")
    expect(window.location.hash).toBe("")
    expect(takeFragmentToken()).toBe("good")
  })

  it("does not carry a token to a page that was opened without one", () => {
    window.history.replaceState(null, "", "/invite#good")
    takeFragmentToken()
    forgetFragmentToken()
    expect(takeFragmentToken()).toBeNull()
  })

  it.each([
    ["invite", "/invite#good", InvitePage, inspectInvite],
    ["reset", "/reset#good", ResetPage, inspectReset],
  ] as const)("the %s page inspects the token when a suspending sibling makes it render twice", async (_n, url, Page, inspect) => {
    suspended = false
    window.history.replaceState(null, "", url)
    render(<Suspense fallback={null}><Page /><SuspendsOnce /></Suspense>)
    await waitFor(() => expect(inspect).toHaveBeenCalledWith("good"))
  })

  it.each([
    ["invite", "/invite#good", InvitePage, inspectInvite],
    ["reset", "/reset#good", ResetPage, inspectReset],
  ] as const)("the %s page inspects the token when its initializers run twice", async (_n, url, Page, inspect) => {
    window.history.replaceState(null, "", url)
    render(<StrictMode><Page /></StrictMode>)
    await waitFor(() => expect(inspect).toHaveBeenCalledWith("good"))
    expect(window.location.hash).toBe("")
  })
})
