import { act, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULTS, type HundredfoldSettings } from "@/lib/settings"
import { TalkOrbOverlay } from "../talk-orb-overlay"
import { clearResumableTalkSession, setTalkSessionId } from "../talk-session-store"

vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({ subscribe: () => () => {} }) }))

/** Counts module evaluations, so "the chunk is not fetched" is an assertion
 *  rather than a hope: the factory only runs when the lazy import resolves. */
const orb = vi.hoisted(() => ({ loads: 0, variants: [] as string[] }))

vi.mock("../talk-orb", () => {
  orb.loads += 1
  return { TalkOrb: ({ variant }: { variant?: string }) => {
    if (variant) orb.variants.push(variant)
    return <div data-talk-orb data-orb-variant={variant} />
  } }
})

const stored = vi.hoisted(() => ({ settings: {} as HundredfoldSettings }))

vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({ settings: stored.settings }),
}))

const bindTalkActionLog = vi.fn()
vi.mock("../talk-action-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../talk-action-log")>()),
  bindTalkActionLog: (id: string | null) => bindTalkActionLog(id),
}))

function withTalkOrb(enabled: boolean, variant = DEFAULTS.talkOrbVariant) {
  stored.settings = { ...DEFAULTS, talkOrb: enabled, talkOrbVariant: variant }
}

afterEach(() => {
  orb.loads = 0
  orb.variants = []
  bindTalkActionLog.mockClear()
  act(() => setTalkSessionId(null))
  clearResumableTalkSession()
})

describe("TalkOrbOverlay", () => {
  it("is off by default", () => {
    expect(DEFAULTS.talkOrb).toBe(false)
  })

  it("renders nothing and loads nothing while the setting is off", () => {
    withTalkOrb(false)

    const { container } = render(<TalkOrbOverlay />)

    expect(container.innerHTML).toBe("")
    expect(orb.loads).toBe(0)
  })

  it("renders the sphere once the setting is on", async () => {
    withTalkOrb(true)

    render(<TalkOrbOverlay />)

    // waitFor's one-second default is a budget for a render, and this waits on a
    // cold dynamic import instead: transforming the talk-surface module graph
    // costs ~520ms on an idle machine, so a loaded one times out.
    await waitFor(() => expect(document.querySelector("[data-talk-orb]")).not.toBeNull(), {
      timeout: 15_000,
    })
    expect(orb.loads).toBe(1)
  })

  it("hands the persisted paint strategy to the live control", async () => {
    withTalkOrb(true, "ring")

    render(<TalkOrbOverlay />)

    await waitFor(() => expect(document.querySelector("[data-talk-orb]")?.getAttribute("data-orb-variant")).toBe("ring"), {
      timeout: 15_000,
    })
    expect(orb.variants).toContain("ring")
  })

  it("hands the open talk session down to the surface, and lets it go on the way out", async () => {
    withTalkOrb(true)
    act(() => setTalkSessionId("talk-9"))

    const mounted = render(<TalkOrbOverlay />)
    await waitFor(() => expect(bindTalkActionLog).toHaveBeenLastCalledWith("talk-9"))

    mounted.unmount()

    expect(bindTalkActionLog).toHaveBeenLastCalledWith(null)
  })

  it("binds no session while none is open, which is what production does today", async () => {
    withTalkOrb(true)

    render(<TalkOrbOverlay />)

    await waitFor(() => expect(bindTalkActionLog).toHaveBeenCalled())
    expect(bindTalkActionLog).toHaveBeenLastCalledWith(null)
  })
})
