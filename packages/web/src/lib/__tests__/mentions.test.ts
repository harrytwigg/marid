import { describe, expect, it } from "vitest"
import type { Employee } from "@/lib/api"
import {
  activeMention,
  filterMentionCandidates,
  findMentions,
  insertMention,
  mentionRoster,
} from "../mentions"

const names = (text: string) => findMentions(text).map((t) => t.name)

describe("findMentions", () => {
  it("reads the name without trailing punctuation", () => {
    expect(names("ping @build-lead, please look")).toEqual(["build-lead"])
  })

  it("finds a mention inside parentheses and at the very start", () => {
    expect(names("(@a)")).toEqual(["a"])
    expect(names("@a hello")).toEqual(["a"])
  })

  it("ignores an @ that is part of an email, a path, a handle or a doubled @", () => {
    expect(names("mail x@y.com")).toEqual([])
    expect(names("see src/@a/index.ts")).toEqual([])
    expect(names("@@a")).toEqual([])
    expect(names("a.@b")).toEqual([])
  })

  it("ignores inline code and fenced code, but not prose around them", () => {
    expect(names("run `@a` now")).toEqual([])
    expect(names("```sh\n@a\n```\n@b")).toEqual(["b"])
    expect(names("```\n@a\nnever closed")).toEqual([])
  })

  it("trims a trailing dash or underscore, then lowercases", () => {
    expect(names("@Build-")).toEqual(["build"])
    expect(names("@a_b__ x")).toEqual(["a_b"])
    expect(names("@Test-Lead")).toEqual(["test-lead"])
  })

  it("needs an alphanumeric first character", () => {
    expect(names("@-a @_a @")).toEqual([])
  })

  it("reports where the token sits so a renderer can split around it", () => {
    expect(findMentions("hi @a- there")).toEqual([{ name: "a", start: 3, end: 5 }])
  })
})

const emp = (name: string, displayName: string, system = false) =>
  ({ name, displayName, system }) as Employee

describe("the picker's lookups", () => {
  const roster = mentionRoster([
    emp("build-lead", "Build Lead"),
    emp("test-lead", "Test Lead"),
    emp("ops-bot", "Ops", true),
    emp("qa", "Quality"),
  ])

  it("leaves system employees off the roster", () => {
    expect(roster.map((e) => e.name)).not.toContain("ops-bot")
  })

  it("matches the name or the display name by prefix, ignoring case", () => {
    expect(filterMentionCandidates(roster, "TEST-L").map((e) => e.name)).toEqual(["test-lead"])
    expect(filterMentionCandidates(roster, "quality").map((e) => e.name)).toEqual(["qa"])
    expect(filterMentionCandidates(roster, "lead")).toEqual([])
  })

  it("offers everyone on a bare @, capped at eight", () => {
    const many = Array.from({ length: 12 }, (_, i) => emp(`e${i}`, `E ${i}`))
    expect(filterMentionCandidates(many, "")).toHaveLength(8)
  })

  it("finds the prefix being typed at the caret and nothing else", () => {
    expect(activeMention("hi @jun", 7)).toEqual({ start: 3, query: "jun" })
    expect(activeMention("hi @", 4)).toEqual({ start: 3, query: "" })
    expect(activeMention("hi @jun there", 13)).toBeNull()
    expect(activeMention("x@jun", 5)).toBeNull()
  })

  it("replaces the typed @prefix and puts the caret after the inserted space", () => {
    expect(insertMention("hi @te and more", 3, 6, "test-lead")).toEqual({
      value: "hi @test-lead  and more",
      caret: 14,
    })
  })
})
