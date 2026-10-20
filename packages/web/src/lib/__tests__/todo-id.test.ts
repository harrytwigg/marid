import { describe, expect, it } from "vitest"
import * as todoId from "../todo-id"

describe("Todo ID mentions", () => {
  it("exports the mention grammar for inline renderers", () => {
    expect(todoId.TODO_ID_MENTION_SOURCE).toBeTypeOf("string")
  })

  it("matches valid IDs within prose", () => {
    const regex = new RegExp(todoId.TODO_ID_MENTION_SOURCE, "g")

    expect("Open ISS-637 and TSK-18 now".match(regex)).toEqual(["ISS-637", "TSK-18"])
  })

  it("rejects shape-adjacent junk and zero ordinals", () => {
    const regex = new RegExp(todoId.TODO_ID_MENTION_SOURCE, "g")

    expect("XISS-637 ISS-637-2 ISS-5.6 ISS-0 -ISS-8".match(regex)).toBeNull()
  })
})
