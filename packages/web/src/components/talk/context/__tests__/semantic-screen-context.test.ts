import { afterEach, describe, expect, it } from "vitest"
import { queryClient } from "@/lib/query-client"
import { describeLocation } from "../page-snapshot"
import { buildScreenContext } from "../surface-adapters"

function root(markup: string): HTMLElement {
  const element = document.createElement("main")
  element.innerHTML = markup
  document.body.append(element)
  return element
}

afterEach(() => {
  queryClient.clear()
  document.body.replaceChildren()
})

describe("authoritative semantic screen context", () => {
  it("grounds a blocked Todo in its cached source object, relations, filters, and visible controls", () => {
    queryClient.setQueryData(["work-item", "PLA-116"], {
      workItem: {
        id: "PLA-116",
        version: 7,
        title: "Universal Talk control",
        status: "blocked",
        body: "Waiting for the canonical command seam.",
        assignee: "platform-lead",
        department: "platform",
        priority: 3,
        source: "delegation",
        sourceRef: "session:sess-related",
        updatedAt: "2026-08-18T08:00:00.000Z",
      },
      events: [{
        id: "event-1",
        kind: "status_change",
        fromStatus: "executing",
        toStatus: "blocked",
        actor: "platform-lead",
        detail: { note: "The command seam must land first.", blockKind: "dependency" },
        createdAt: "2026-08-18T08:00:00.000Z",
      }],
      relations: [{
        kind: "relates",
        direction: "out",
        other: { id: "PLA-115", title: "Canonical commands", status: "executing" },
      }],
      runs: [{ sessionId: "sess-related", outcome: null }],
    })
    queryClient.setQueryData(["work-item-sessions", "PLA-116"], [
      { id: "sess-related", title: "Platform discussion", status: "idle" },
    ])

    const context = buildScreenContext({
      location: describeLocation("/todos/PLA-116", "?status=blocked"),
      browserInstanceId: "browser-1",
      root: root(`
        <h1>Universal Talk control</h1>
        <button>Edit priority</button>
        <button data-talk-secret>Reveal token abc-secret</button>
        <section data-talk-orb-overlay>Listening</section>
      `),
      capturedAt: "2026-08-18T08:01:00.000Z",
    })

    expect(context).toMatchObject({
      version: 1,
      routeId: "todo-detail",
      freshness: "complete",
      browserInstanceId: "browser-1",
      selectedObject: {
        kind: "Todo",
        id: "PLA-116",
        title: "Universal Talk control",
        status: "blocked",
        fields: {
          blockedReason: "The command seam must land first.",
          sourceRef: "session:sess-related",
        },
        relations: [
          { kind: "relates", id: "PLA-115", title: "Canonical commands", status: "executing" },
          { kind: "session", id: "sess-related", title: "Platform discussion", status: "idle" },
        ],
        retrievalAnchor: { kind: "work-item", id: "PLA-116", version: 7 },
      },
    })
    expect(context.controls.map((control) => control.label)).toContain("Edit priority")
    expect(context.meaningfulText).toContain("Universal Talk control")
    expect(JSON.stringify(context)).not.toContain("abc-secret")
    expect(JSON.stringify(context)).not.toContain("Listening")
  })

  it("marks a selected object partial instead of inventing detail when its source object is cold", () => {
    const context = buildScreenContext({
      location: describeLocation("/todos/PLA-404", ""),
      browserInstanceId: "browser-1",
      root: root("<h1>Loading Todo</h1>"),
      capturedAt: "2026-08-18T08:01:00.000Z",
    })

    expect(context.freshness).toBe("partial")
    expect(context.missing).toContain("selected-object")
    expect(context.selectedObject).toBeNull()
  })

  it("declares graph layout as visual-only evidence while preserving structured workflow state", () => {
    queryClient.setQueryData(["workflows", "definition", "release"], {
      id: "release",
      title: "Release train",
      revision: 4,
      enabled: true,
      nodes: [{ id: "build", type: "employee", name: "Build", config: {} }],
      edges: [],
      ui: { positions: { build: { x: 100, y: 80 } } },
    })
    const context = buildScreenContext({
      location: describeLocation("/workflow/release", ""),
      browserInstanceId: "browser-1",
      root: root('<h1>Release train</h1><div data-talk-visual-gap="workflow-graph-spatial-layout"></div>'),
      capturedAt: "2026-08-18T08:01:00.000Z",
    })

    expect(context.selectedObject).toMatchObject({ id: "release", title: "Release train", status: "enabled" })
    expect(context.visualGaps).toEqual(["workflow-graph-spatial-layout"])
  })
})

describe("the Auto-Dispatch destination", () => {
  it("is a page Talk can name, not an unknown path — as its coverage entry claims", () => {
    expect(describeLocation("/auto-dispatch", "")).toMatchObject({ kind: "auto-dispatch", path: "/auto-dispatch" })
    expect(describeLocation("/auto-dispatch/extra", "").kind).toBe("other")
  })
})
