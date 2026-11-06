import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ClientProviders } from "./client-providers"

/** A signed-in member gets their own app; nothing of the operator's shell (Talk, plugins, the socket bridge) mounts for them. */
const mounted = vi.hoisted(() => ({ orb: 0, plugins: 0 }))
let principal: { kind: string } | null = null
const passThrough = vi.hoisted(() => ({ children }: { children: ReactNode }) => children)

vi.mock("@/routes/providers", () => ({ ThemeProvider: passThrough }))
vi.mock("@/routes/auth-provider", () => ({ AuthProvider: passThrough, AuthGate: passThrough, useAuth: () => ({ principal }), useAuthOptional: () => ({ principal }) }))
vi.mock("@/routes/settings-provider", () => ({ SettingsProvider: passThrough, DocumentTitle: () => null, useSettings: () => ({ settings: { talkOrb: false } }) }))
vi.mock("@/hooks/use-gateway", () => ({ GatewayProvider: passThrough, useGateway: () => ({ connected: false, subscribe: () => () => {} }) }))
vi.mock("@/hooks/use-query-invalidation", () => ({ useQueryInvalidation: () => {} }))
vi.mock("@/components/brand-favicon", () => ({ BrandFavicon: () => null }))
vi.mock("@/components/talk/talk-orb-overlay", () => ({ TalkOrbOverlay: () => { mounted.orb += 1; return null } }))
vi.mock("@/routes/member/member-root", () => ({ default: () => <div data-testid="member-app" /> }))

beforeEach(() => { mounted.orb = 0 })

describe("ClientProviders by principal", () => {
  it("mounts only the member app for a member", async () => {
    principal = { kind: "member" }
    render(<MemoryRouter><ClientProviders><div data-testid="operator-routes" /></ClientProviders></MemoryRouter>)
    expect(await screen.findByTestId("member-app")).toBeTruthy()
    expect(screen.queryByTestId("operator-routes")).toBeNull()
    expect(mounted.orb).toBe(0)
  })

  it("mounts the operator's app, and no member app, for the operator and when there is no principal", async () => {
    for (const p of [{ kind: "operator" }, null]) {
      principal = p
      const { unmount } = render(<MemoryRouter><ClientProviders><div data-testid="operator-routes" /></ClientProviders></MemoryRouter>)
      expect(screen.getByTestId("operator-routes")).toBeTruthy()
      expect(screen.queryByTestId("member-app")).toBeNull()
      unmount()
    }
  })
})
