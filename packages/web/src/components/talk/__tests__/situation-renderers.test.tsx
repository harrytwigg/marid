import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SITUATION_RENDERERS, speech } from "../situation-renderers"
import type { SituationPayload } from "../situation-payload"
import { KINDS, PAYLOADS } from "./situation-fixtures"

vi.mock("@/lib/api", () => ({
  api: {
    getWorkItem: vi.fn(async () => ({ workItem: { id: "AAA-1", title: "A Todo", status: "assigned", assignee: "a-lead" } })),
    getSession: vi.fn(async () => ({ title: "A session" })),
  },
}))

function renderKind(kind: SituationPayload["kind"]) {
  const { Render } = SITUATION_RENDERERS[kind]
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Render payload={PAYLOADS[kind] as never} onAnswer={() => {}} />
    </QueryClientProvider>,
  )
}

describe("SITUATION_RENDERERS", () => {
  it("has an entry for every kind in the union and nothing else", () => {
    expect(Object.keys(SITUATION_RENDERERS).sort()).toEqual([...KINDS].sort())
  })

  it("draws each kind under its own renderer marker", () => {
    for (const kind of KINDS) {
      const { unmount } = renderKind(kind)
      expect(document.querySelector(`[data-situation-renderer="${kind}"]`)).not.toBeNull()
      unmount()
    }
  })
})

describe("speech", () => {
  it("says something derived from the payload for every kind", () => {
    for (const kind of KINDS) {
      const spoken = speech(PAYLOADS[kind])
      expect(spoken.trim().length).toBeGreaterThan(0)
    }
  })

  it("reads the payload's own words back, not a hardcoded line", () => {
    expect(speech(PAYLOADS.prose)).toContain("repeats the first")
    expect(speech(PAYLOADS.options)).toContain("Ship it")
    expect(speech(PAYLOADS.options)).toContain("Revise")
    expect(speech(PAYLOADS.images)).toContain("Variant A")
    expect(speech(PAYLOADS.video)).toContain("Slow cut")
    expect(speech(PAYLOADS.object)).toContain("AAA-1")
  })
})
