import { describe, expect, it } from "vitest"
import { describeScreenLocation } from "../todos-tab-snapshot"

const tab = { board: { kind: "department", slug: "platform" } as const, search: "assignee=scout&q=a" }

describe("the screen described with the Todos tab", () => {
  it("is the board at the tab's board and filters while the tab is the focused one on the chat route", () => {
    const snapshot = describeScreenLocation("/", "?session=x", tab)
    expect(snapshot).toMatchObject({ kind: "todos", params: { board: "platform" }, filters: { assignee: "scout", q: "a" }, selection: null })
  })

  it("is the chat when the tab is not focused", () => {
    expect(describeScreenLocation("/", "?session=x", null)).toMatchObject({ kind: "chat", selection: { kind: "chat session", id: "x" } })
  })

  it("leaves every other page to its own address", () => {
    expect(describeScreenLocation("/org", "", tab)).toMatchObject({ kind: "org" })
  })

  it("describes a tab with no filters as the bare board", () => {
    expect(describeScreenLocation("/", "", { board: { kind: "everything" }, search: "" })).toMatchObject({ kind: "todos", params: { board: "everything" }, filters: {} })
  })
})
