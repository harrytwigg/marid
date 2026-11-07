import { Suspense } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { createBrowserGatewayTransport, installGatewayTransport } from "@/lib/gateway-transport"
import { PublicShell } from "./public-shell"

/** An invitee has no session. While their page's chunk loads they see a plain frame: no operator navigation, no gateway call. */
const request = vi.fn(async () => new Response("{}"))
let restore: () => void

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia
  cleanup()
  restore?.()
  request.mockClear()
})

function Pending(): never {
  throw new Promise(() => {})
}

describe("PublicShell while its page loads", () => {
  it("shows a loading frame with no tab bar and calls nothing", () => {
    restore = installGatewayTransport(createBrowserGatewayTransport({ origin: "http://gateway.test", navigate: vi.fn(), request }))
    render(<PublicShell><Suspense fallback={null}><div /></Suspense><Pending /></PublicShell>)
    expect(screen.getByRole("status", { name: "Loading page" })).toBeTruthy()
    expect(document.querySelector("nav")).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})
