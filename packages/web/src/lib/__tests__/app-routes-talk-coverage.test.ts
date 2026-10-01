import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { APP_ROUTES, matchAppRoute } from "../app-routes"
import { renderTalkCoverageMarkdown, TALK_SURFACE_COVERAGE, validateTalkCoverage } from "@/components/talk/context/coverage"
import { legacyChatRedirectTarget } from "@/routes/chat/legacy-chat-redirect"

describe("Talk coverage of the routes the app can render", () => {
  it("leaves no core route without semantic context and an evidence path", () => {
    expect(validateTalkCoverage(APP_ROUTES, TALK_SURFACE_COVERAGE)).toEqual([])
  })

  it("matches concrete detail routes to their authoritative descriptors", () => {
    expect(matchAppRoute("/chat/session-7")?.id).toBe("chat-redirect")
    expect(legacyChatRedirectTarget("session 7")).toBe("/?session=session%207")
    expect(matchAppRoute("/todos/PLA-116")?.id).toBe("todo-detail")
    expect(matchAppRoute("/org")?.id).toBe("org")
    expect(matchAppRoute("/settings/plugins")?.id).toBe("settings-plugins")
    expect(matchAppRoute("/notes/f/product/n/product/roadmap")?.id).toBe("notes")
  })

  it("treats contributed routes as an explicit SDK-dependent gap, never as a core page guess", () => {
    const route = matchAppRoute("/customer-plugin/report")
    expect(route?.id).toBe("plugin-contributed")
    expect(TALK_SURFACE_COVERAGE[route!.id]).toMatchObject({
      status: "explicit-gap",
      reason: "plugin-context-unavailable",
    })
  })

  it("keeps the checked-in operator inventory fresh", () => {
    const documented = readFileSync("../../docs/talk-control-coverage.md", "utf8")
    expect(documented.startsWith(renderTalkCoverageMarkdown(APP_ROUTES, TALK_SURFACE_COVERAGE))).toBe(true)
  })
})
