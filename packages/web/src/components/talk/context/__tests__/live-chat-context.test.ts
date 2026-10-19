import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __cacheLiveSessionSnapshotForTests,
  __clearLiveSessionSnapshotCacheForTests,
} from "@/hooks/use-live-session"
import type { Message } from "@/lib/conversations"
import { queryClient } from "@/lib/query-client"
import { queryKeys } from "@/lib/query-keys"
import { describeLocation } from "../page-snapshot"
import { publishScreenContext, resetPageContext } from "../page-context-store"
import { PAGE_CONTEXT_BUDGET_CHARS, renderPageContext } from "../render-page-context"
import { buildScreenContext } from "../surface-adapters"
import { visibleObjects } from "../visible-objects"
import { createTalkDriver, PAGE_CONTEXT_DEBOUNCE_MS } from "../../transport/session-driver"
import { browserControlFixture } from "../../transport/__tests__/control-fixture"
import { FakeConnection } from "../../transport/__tests__/fake-connection"

const SESSION_ID = "123e4567-e89b-12d3-a456-426614174000"
const OTHER_SESSION_ID = "223e4567-e89b-12d3-a456-426614174000"
const HERE = { name: "acme", port: "7778" }
const CAPTURED_AT = "2026-08-18T12:00:00.000Z"
const NOW = Date.parse(CAPTURED_AT)

function message(id: string, role: Message["role"], content: string, timestamp: number): Message {
  return { id, role, content, timestamp }
}

function cache(
  messages: Message[],
  streamingText: string,
  status = "running",
  id = SESSION_ID,
  title = "Platform standup",
): void {
  __cacheLiveSessionSnapshotForTests(id, {
    messages,
    streamingText,
    loading: status === "running",
    turnPending: status === "running",
    session: {
      id,
      title,
      employee: "platform-lead",
      status,
    },
    liveContextTokens: null,
    backgroundActivity: null,
  })
}

function screen(visibleText = "Chat", id = SESSION_ID) {
  const root = document.createElement("main")
  root.innerHTML = `<h1>Chat</h1><p>${visibleText}</p>`
  return buildScreenContext({
    location: describeLocation("/", `?session=${id}`),
    browserInstanceId: "browser-1",
    root,
    capturedAt: CAPTURED_AT,
  })
}

function attached() {
  let connection: FakeConnection | null = null
  const driver = createTalkDriver({
    sessionId: "talk-1",
    manifest: browserControlFixture(),
    send: (event) => connection?.send(event),
    onState: () => {},
    onError: () => {},
  })
  connection = new FakeConnection({ token: "token", onOpen: () => {}, onFrame: driver.receive })
  return { driver, connection }
}

function updates(connection: FakeConnection): Array<Record<string, unknown>> {
  return connection.sent.filter((event: Record<string, unknown>) => event.type === "session.update")
}

function instructions(event: Record<string, unknown>): string {
  return (event.session as { instructions: string }).instructions
}

beforeEach(() => {
  vi.useFakeTimers()
  resetPageContext()
  __clearLiveSessionSnapshotCacheForTests()
  queryClient.removeQueries({ queryKey: queryKeys.sessions.all })
})

afterEach(() => {
  vi.useRealTimers()
  resetPageContext()
  __clearLiveSessionSnapshotCacheForTests()
  FakeConnection.opened.length = 0
})

describe("bounded live chat context", () => {
  it("renders a friendly live packet with stable recent blocks and no session UUID or raw token tail", () => {
    cache([
      message("message-0", "assistant", "An older settled answer.", NOW - 120_000),
      message("message-1", "assistant", "A recent pre-turn note.", NOW - 50_000),
      message("message-2", "user", "Should the ring stay?", NOW - 40_000),
      {
        ...message("message-3", "assistant", "The ring keeps the state legible.", NOW - 10_000),
        blocks: [{
          id: "block-synthetic-1",
          type: "delegation",
          version: 2,
          status: "completed",
          title: "Fixture review",
          summary: "Seven cases checked",
          payload: {},
        }],
      },
      {
        ...message("message-4", "assistant", "An unfinished answer.", NOW - 5_000),
        partial: true,
        blocks: [{
          id: "block-synthetic-2",
          type: "delegation",
          version: 2,
          status: "running",
          title: "Unfinished fixture review",
          summary: "Raw partial block",
          payload: {},
        }],
      },
    ], "unsettled raw token tail")

    const context = screen("unsettled raw token tail")
    const rendered = renderPageContext(context, [], HERE)

    expect(context.selectedObject).toMatchObject({
      kind: "chat session",
      title: "Platform standup",
      status: "running",
      fields: {
        participants: ["operator", "platform-lead"],
        activity: "still writing",
        recentBlocks: [
          { role: "assistant", text: "An older settled answer.", recency: "earlier" },
          { role: "assistant", text: "A recent pre-turn note.", recency: "just now" },
          { role: "user", text: "Should the ring stay?", recency: "this turn" },
          { role: "assistant", text: "The ring keeps the state legible.", recency: "this turn" },
        ],
        stableBlocks: [{ type: "delegation", title: "Fixture review", status: "completed", summary: "Seven cases checked", recency: "this turn" }],
      },
    })
    expect(rendered).toContain("Platform standup")
    expect(rendered).toContain("operator, platform-lead")
    expect(rendered).toContain("still writing")
    expect(rendered).toContain("Should the ring stay?")
    expect(rendered).toContain("The ring keeps the state legible.")
    expect(rendered).toContain("this turn")
    expect(rendered).toContain("just now")
    expect(rendered).toContain("earlier")
    expect(rendered).toContain("Fixture review · completed · Seven cases checked")
    expect(rendered).not.toContain("Unfinished fixture review")
    expect(rendered).not.toContain("An unfinished answer.")
    // The one identifier the packet carries: the chat the operator has actually
    // selected, stated as a handle. Without it the model can read the title off
    // the screen but cannot name the session to `read_session`, so asked what it
    // is looking at it narrates — the hallucination this guards against.
    expect(rendered).toContain(`Selected session id: ${SESSION_ID}`)
    expect(rendered).toContain("a handle to use, never something to say")
    expect(rendered).not.toContain("unsettled raw token tail")
    expect(context.meaningfulText).not.toContain("unsettled raw token tail")
    expect(rendered).toContain("titles, people, topics, and relative time")
    expect(rendered).toContain("not identifiers unless explicitly asked")
  })

  it("carries the selected session's id and no other chat's, from the production chat list", () => {
    cache([message("message-1", "assistant", "The current answer.", NOW - 5_000)], "", "idle")
    queryClient.setQueryData(queryKeys.sessions.all, {
      sessions: [
        { id: SESSION_ID, title: "Platform standup" },
        { id: OTHER_SESSION_ID, title: "Release room" },
      ],
    })
    const context = screen()

    const rendered = renderPageContext(context, visibleObjects(context), HERE)

    expect(rendered).toContain("Platform standup")
    expect(rendered).toContain("Release room")
    expect(rendered).toContain(`Selected session id: ${SESSION_ID}`)
    // The chat LIST stays titles: `objectLine` withholds ids on a chat page, so
    // only what the operator selected is addressable.
    expect(rendered).not.toContain(OTHER_SESSION_ID)
  })

  it("drops token churn and sends one debounced update when a stable block closes", () => {
    const stable = [message("message-1", "user", "Summarize the plan.", 1)]
    cache(stable, "first raw token")
    publishScreenContext(screen("first raw token"))
    const talk = attached()
    talk.driver.start()

    for (const raw of ["first raw token grows", "first raw token grows again", "rewritten raw token"]) {
      cache(stable, raw)
      publishScreenContext(screen(raw))
      vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS / 4)
    }
    vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS)
    expect(updates(talk.connection)).toHaveLength(1)

    cache([...stable, message("message-2", "assistant", "The stable answer is ready.", 2)], "")
    publishScreenContext(screen())
    vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS)

    expect(updates(talk.connection)).toHaveLength(2)
    expect(instructions(updates(talk.connection)[1]!)).toContain("The stable answer is ready.")
    expect(instructions(updates(talk.connection)[1]!)).toContain(`Selected session id: ${SESSION_ID}`)
  })

  it("replaces one visible chat packet with the next chat rather than retaining the old tail", () => {
    cache([message("message-1", "assistant", "First chat answer.", NOW - 20_000)], "", "idle")
    cache(
      [message("message-2", "assistant", "Second chat answer.", NOW - 5_000)],
      "",
      "idle",
      OTHER_SESSION_ID,
      "Release room",
    )
    publishScreenContext(screen("First chat answer."))
    const talk = attached()
    talk.driver.start()

    publishScreenContext(screen("Second chat answer.", OTHER_SESSION_ID))
    vi.advanceTimersByTime(PAGE_CONTEXT_DEBOUNCE_MS)

    const latest = instructions(updates(talk.connection).at(-1)!)
    expect(latest).toContain("Release room")
    expect(latest).toContain("Second chat answer.")
    expect(latest).not.toContain("Platform standup")
    expect(latest).not.toContain("First chat answer.")
    // The handle moves with the selection: the new chat's id replaces the old
    // one rather than both being carried.
    expect(latest).toContain(`Selected session id: ${OTHER_SESSION_ID}`)
    expect(latest).not.toContain(SESSION_ID)
  })

  it("keeps the newest stable tail when the 1200-character packet has to drop older context", () => {
    const longMessages = Array.from({ length: 6 }, (_, index) => message(
      `message-${index}`,
      index % 2 === 0 ? "user" : "assistant",
      `MARKER-${index} ${"detail ".repeat(40)}`,
      NOW - (6 - index) * 10_000,
    ))
    cache(longMessages, "", "idle")

    const rendered = renderPageContext(screen(), [], HERE)

    expect(rendered.length).toBeLessThanOrEqual(PAGE_CONTEXT_BUDGET_CHARS)
    expect(rendered).toContain("MARKER-5")
    // MARKER-2 is still in the bounded four-message tail. Its absence proves the
    // renderer spent the budget newest-first rather than merely slicing the source.
    expect(rendered).not.toContain("MARKER-2")
    expect(rendered).not.toContain("MARKER-0")
    expect(rendered).not.toContain("MARKER-1")
  })

  it("keeps the newest message ahead of older stable blocks under the mixed packet budget", () => {
    const older = Array.from({ length: 4 }, (_, index): Message => ({
      ...message(`message-${index}`, "assistant", `OLDER-MESSAGE-${index} ${"detail ".repeat(40)}`, NOW - (5 - index) * 10_000),
      blocks: [{
        id: `block-${index}`,
        type: "delegation",
        version: 2,
        status: "completed",
        title: `OLDER-BLOCK-${index} ${"detail ".repeat(40)}`,
        summary: "summary ".repeat(40),
        payload: {},
      }],
    }))
    cache([
      ...older,
      message("message-newest", "assistant", `NEWEST-MESSAGE ${"detail ".repeat(40)}`, NOW - 1_000),
    ], "", "idle")

    const rendered = renderPageContext(screen(), [], HERE)

    expect(rendered.length).toBeLessThanOrEqual(PAGE_CONTEXT_BUDGET_CHARS)
    expect(rendered).toContain("NEWEST-MESSAGE")
  })
})
