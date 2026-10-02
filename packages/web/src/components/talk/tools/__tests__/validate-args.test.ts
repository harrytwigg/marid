import { describe, expect, it } from "vitest"
import { parseToolArgs } from "../validate-args"
import { params, str } from "../tool-spec"

const SHAPE = params(
  {
    id: str("The Todo id."),
    lens: str("Which lens to open.", ["editor", "runs"]),
    limit: { type: "integer" as const, description: "How many rows." },
    expand: { type: "boolean" as const, description: "Include the body." },
  },
  ["id"],
)

describe("parseToolArgs", () => {
  it("treats an absent or empty argument string as no arguments", () => {
    const shape = params({ q: str("A query.") })
    expect(parseToolArgs("open_todos", shape, "")).toEqual({ ok: true, args: {} })
    expect(parseToolArgs("open_todos", shape, "   ")).toEqual({ ok: true, args: {} })
  })

  it("accepts a well-formed object", () => {
    const parsed = parseToolArgs("open_todo", SHAPE, '{"id":"ICI-59","limit":5,"expand":true}')
    expect(parsed).toEqual({ ok: true, args: { id: "ICI-59", limit: 5, expand: true } })
  })

  it("says what would fix malformed JSON", () => {
    const parsed = parseToolArgs("open_todo", SHAPE, "{id: 59")
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected a failure")
    expect(parsed.error).toContain("open_todo")
    expect(parsed.error).toContain("valid JSON")
    // The message has to carry an example, or the model cannot self-correct.
    expect(parsed.error).toContain('{"id"')
  })

  it("rejects a JSON value that is not an object", () => {
    const parsed = parseToolArgs("open_todo", SHAPE, '"ICI-59"')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected a failure")
    expect(parsed.error).toContain("JSON object")
  })

  it("names the missing required argument", () => {
    const parsed = parseToolArgs("open_todo", SHAPE, '{"limit":3}')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected a failure")
    expect(parsed.error).toContain('"id"')
    expect(parsed.error).toContain("required")
  })

  it("treats an explicit null for a required argument as missing", () => {
    const parsed = parseToolArgs("open_todo", SHAPE, '{"id":null}')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected a failure")
    expect(parsed.error).toContain('"id"')
  })

  it("drops a null for an optional argument rather than failing on it", () => {
    const parsed = parseToolArgs("open_todo", SHAPE, '{"id":"ICI-59","lens":null}')
    expect(parsed).toEqual({ ok: true, args: { id: "ICI-59" } })
  })

  it("lists the accepted arguments when given an unknown one", () => {
    const parsed = parseToolArgs("open_todo", SHAPE, '{"id":"ICI-59","colour":"red"}')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected a failure")
    expect(parsed.error).toContain('"colour"')
    expect(parsed.error).toContain("id, lens, limit, expand")
  })

  it("names the expected type on a type mismatch", () => {
    const parsed = parseToolArgs("open_todo", SHAPE, '{"id":"ICI-59","limit":"five"}')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected a failure")
    expect(parsed.error).toContain('"limit"')
    expect(parsed.error).toContain("integer")
  })

  it("rejects a fractional value for an integer argument", () => {
    const parsed = parseToolArgs("open_todo", SHAPE, '{"id":"ICI-59","limit":2.5}')
    expect(parsed.ok).toBe(false)
  })

  it("lists the allowed values when an enum is violated", () => {
    const parsed = parseToolArgs("open_todo", SHAPE, '{"id":"a","lens":"timeline"}')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected a failure")
    expect(parsed.error).toContain("editor, runs")
  })

  it("accepts a spoken number for a string argument, because speech has no types", () => {
    const parsed = parseToolArgs("open_todo", SHAPE, '{"id":59}')
    expect(parsed).toEqual({ ok: true, args: { id: "59" } })
  })
})
