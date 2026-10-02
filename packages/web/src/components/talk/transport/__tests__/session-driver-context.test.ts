import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

const { createTalkDriver, PAGE_CONTEXT_DEBOUNCE_MS } = await import("../session-driver")
const { toolDefinitions } = await import("@/components/talk/tools/registry")
const { describeLocation } = await import("@/components/talk/context/page-snapshot")
const { publishPageContext, resetPageContext } = await import("@/components/talk/context/page-context-store")
const { FakeConnection } = await import("./fake-connection")
type Fake = InstanceType<typeof FakeConnection>
const { browserControlFixture } = await import("./control-fixture")

/** A driver speaking over a fake data channel, exactly as `useAttach` wires the
 *  real one: the driver is built first, and sends through the connection. */
function attached(brief?: string) {
  let connection: Fake | null = null
  const driver = createTalkDriver({
    sessionId: "talk-1",
    manifest: browserControlFixture(),
    brief,
    send: (event) => connection?.send(event),
    onState: () => {},
    onError: () => {},
  })
  connection = new FakeConnection({ token: "t", onOpen: () => {}, onFrame: driver.receive })
  return { driver, connection }
}

/** Every `session.update` the driver has put on the channel. */
function updates(connection: Fake): Array<Record<string, unknown>> {
  return connection.sent.filter((event: Record<string, unknown>) => event.type === "session.update")
}

function instructionsOf(event: Record<string, unknown>): string {
  return (event.session as { instructions?: string }).instructions ?? ""
}

function go(pathname: string, search = "") {
  publishPageContext(describeLocation(pathname, search))
}

beforeEach(() => {
  vi.useFakeTimers()
  resetPageContext()
  authFetch.mockReset()
  authFetch.mockResolvedValue(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))
})

afterEach(() => {
  vi.useRealTimers()
  resetPageContext()
  FakeConnection.opened.length = 0
})

describe("orienting the session on the page it opened on", () => {
  it("declares the tools and the current page in one update", () => {
    go("/todos/b/platform", "?status=executing")
    const { driver, connection } = attached()

    driver.start()

    expect(updates(connection)).toHaveLength(1)
    const session = updates(connection)[0]!.session as { tools: Array<{ name: string }>; instructions: string }
    expect(session.tools.map((tool) => tool.name)).toEqual(toolDefinitions().map((tool) => tool.name))
    expect(session.instructions).toContain("/todos/b/platform")
    expect(session.instructions).toContain("status=executing")
  })

  it("names the instance and the port it is served on", () => {
    const { driver, connection } = attached()

    driver.start()

    // jsdom serves the page from localhost with no explicit port.
    expect(instructionsOf(updates(connection)[0]!)).toContain("localhost")
    expect(instructionsOf(updates(connection)[0]!)).toContain("port")
  })
})

describe("following the operator around the app", () => {
  it("sends exactly one update for a route change, carrying the new page", () => {
    const { driver, connection } = attached()
    driver.start()

    go("/todos/b/platform")
    vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS)

    expect(updates(connection)).toHaveLength(2)
    expect(instructionsOf(updates(connection)[1]!)).toContain("/todos/b/platform")
  })

  it("sends exactly one update for a filter change", () => {
    go("/todos/b/platform")
    const { driver, connection } = attached()
    driver.start()

    go("/todos/b/platform", "?status=blocked&q=orb")
    vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS)

    expect(updates(connection)).toHaveLength(2)
    expect(instructionsOf(updates(connection)[1]!)).toContain("status=blocked")
    expect(instructionsOf(updates(connection)[1]!)).toContain("q=orb")
  })

  it("sends exactly one update for a selection change", () => {
    go("/")
    const { driver, connection } = attached()
    driver.start()

    go("/", "?session=sess-4821")
    vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS)

    expect(updates(connection)).toHaveLength(2)
    expect(instructionsOf(updates(connection)[1]!)).toContain("Selected: chat current")
    // The selected chat is addressable (PLA-224 S2): the title is what gets
    // spoken, the id is what gets passed to a tool.
    expect(instructionsOf(updates(connection)[1]!)).toContain("Selected session id: sess-4821")
  })

  it("says nothing when the location is republished unchanged", () => {
    go("/todos/b/platform", "?status=executing")
    const { driver, connection } = attached()
    driver.start()

    go("/todos/b/platform", "?status=executing")
    vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS)

    expect(updates(connection)).toHaveLength(1)
  })

  it("collapses two changes inside the window into one update, carrying the later page", () => {
    const { driver, connection } = attached()
    driver.start()

    go("/todos/b/platform")
    vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS / 2)
    go("/todos/ABC-744")
    vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS)

    expect(updates(connection)).toHaveLength(2)
    expect(instructionsOf(updates(connection)[1]!)).toContain("ABC-744")
    expect(instructionsOf(updates(connection)[1]!)).not.toContain("/todos/b/platform")
  })

  it("carries the whole tool list on every push, so context can never strip the tools", () => {
    const { driver, connection } = attached()
    driver.start()

    for (const path of ["/todos/b/platform", "/todos/ABC-744", "/org", "/cron"]) {
      go(path)
      vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS)
    }

    expect(updates(connection)).toHaveLength(5)
    for (const update of updates(connection)) {
      const tools = (update.session as { tools: Array<{ name: string }> }).tools
      expect(tools.map((tool) => tool.name)).toEqual(toolDefinitions().map((tool) => tool.name))
    }
  })
})

describe("carrying the standing brief the gateway built", () => {
  /** Stands in for whatever `talk/session/brief.ts` produced: the driver treats
   *  it as opaque text and only decides where it goes. */
  const BRIEF = "This instance is Northwind Freight. A Todo is the unit of work."

  it("leads with the brief and keeps the page context after it, in one update", () => {
    go("/todos/b/platform")
    const { driver, connection } = attached(BRIEF)

    driver.start()

    expect(updates(connection)).toHaveLength(1)
    const instructions = instructionsOf(updates(connection)[0]!)
    expect(instructions.startsWith(BRIEF)).toBe(true)
    expect(instructions).toContain("live page context")
    expect(instructions).toContain("/todos/b/platform")
  })

  it("prepends and changes nothing else: without a brief the instructions are what they were", () => {
    go("/todos/ABC-744")
    const withBrief = attached(BRIEF)
    const without = attached()

    withBrief.driver.start()
    without.driver.start()

    expect(instructionsOf(updates(withBrief.connection)[0]!)).toBe(
      `${BRIEF}\n\n${instructionsOf(updates(without.connection)[0]!)}`,
    )
  })

  it("re-sends the brief on a page push, because instructions is replaced rather than merged", () => {
    const { driver, connection } = attached(BRIEF)
    driver.start()

    go("/org")
    vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS)

    expect(updates(connection)).toHaveLength(2)
    expect(instructionsOf(updates(connection)[1]!)).toContain(BRIEF)
    expect(instructionsOf(updates(connection)[1]!)).toContain("/org")
  })
})

describe("standing down", () => {
  it("stops listening, so a page change after stop reaches nobody", () => {
    const { driver, connection } = attached()
    driver.start()

    driver.stop()
    go("/todos/b/platform")
    vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS * 4)

    expect(updates(connection)).toHaveLength(1)
  })

  it("drops an update already waiting out the debounce", () => {
    const { driver, connection } = attached()
    driver.start()

    go("/todos/b/platform")
    driver.stop()
    vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS * 4)

    expect(updates(connection)).toHaveLength(1)
  })
})
