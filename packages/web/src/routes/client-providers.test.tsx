import { readFileSync } from "node:fs"
import { act, render } from "@testing-library/react"
import { useEffect, type ReactNode } from "react"
import { Outlet, RouterProvider, createMemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ClientProviders } from "./client-providers"

/**
 * The orb has to outlive the router. This drives the real `ClientProviders`
 * through real route changes and watches the overlay's mount count.
 */

const orb = vi.hoisted(() => ({ mounts: 0 }))

vi.mock("@/components/talk/talk-orb-overlay", () => ({
  TalkOrbOverlay: () => {
    useEffect(() => {
      orb.mounts += 1
    }, [])
    return <div data-talk-orb-overlay />
  },
}))

/** Everything between the router and the overlay, reduced to pass-throughs —
 *  none of it is what this test is about, and all of it wants a live gateway. */
const passThrough = vi.hoisted(() => ({ children }: { children: ReactNode }) => children)

vi.mock("@/routes/providers", () => ({ ThemeProvider: passThrough }))
vi.mock("@/routes/auth-provider", () => ({ AuthProvider: passThrough, AuthGate: passThrough }))
vi.mock("@/routes/settings-provider", () => ({
  SettingsProvider: passThrough,
  DocumentTitle: () => null,
  useSettings: () => ({ settings: { talkOrb: false } }),
}))
/** Stable identity: the plugin host bridge subscribes in an effect keyed on it. */
const gateway = vi.hoisted(() => ({ connected: false, subscribe: () => () => {} }))

vi.mock("@/hooks/use-gateway", () => ({ GatewayProvider: passThrough, useGateway: () => gateway }))
vi.mock("@/hooks/use-query-invalidation", () => ({ useQueryInvalidation: () => {} }))
vi.mock("@/components/brand-favicon", () => ({ BrandFavicon: () => null }))

function renderApp() {
  const router = createMemoryRouter(
    [
      {
        element: (
          <ClientProviders>
            <Outlet />
          </ClientProviders>
        ),
        children: [
          { path: "/", element: <div>chat</div> },
          { path: "/todos", element: <div>todos</div> },
          { path: "/org", element: <div>org</div> },
        ],
      },
    ],
    { initialEntries: ["/"] },
  )
  const view = render(<RouterProvider router={router} />)
  return { router, view }
}

beforeEach(() => {
  orb.mounts = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("ClientProviders mounts the talk orb above the router", () => {
  it("mounts the overlay once", () => {
    renderApp()

    expect(orb.mounts).toBe(1)
  })

  it("does not remount it across route changes", async () => {
    const { router, view } = renderApp()

    for (const path of ["/todos", "/org", "/"]) {
      await act(async () => {
        await router.navigate(path)
      })
    }

    expect(view.container.textContent).toContain("chat")
    expect(orb.mounts).toBe(1)
  })

  it("keeps the Talk screen-context graph off the first paint", () => {
    const source = readFileSync("src/routes/client-providers.tsx", "utf8")
    expect(source).not.toMatch(/\bimport\s+\{[^}]*TalkContextBridge/)
    expect(source).toMatch(/import\("@\/components\/talk\/context\/talk-context-bridge"\)/)
  })
})
