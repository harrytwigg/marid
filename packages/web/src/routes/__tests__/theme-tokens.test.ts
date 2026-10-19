import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { PALETTE_TOKENS } from "../../components/talk/orb-painters"

const ROUTES = path.resolve(__dirname, "..")
const FILES = ["globals.css", "glass-identity.css"].map((f) => ({
  name: f,
  css: readFileSync(path.join(ROUTES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
}))

type Scheme = "dark" | "light"
/** One theme context a reader can be in: what data-theme says, and, for
 *  "system", what the OS prefers. */
const CONTEXTS = [
  { name: "dark", theme: "dark", os: "dark" },
  { name: "light", theme: "light", os: "dark" },
  { name: "system on a light OS", theme: "system", os: "light" },
  { name: "system on a dark OS", theme: "system", os: "dark" },
] as const

interface Rule {
  media: string | null
  selectors: string[]
  decls: Map<string, string>
}

const PALETTE_SELECTOR = /^(:root|\[data-theme(="(dark|light|system)")?\])$/

function paletteRule(head: string, body: string, media: string | null): Rule | null {
  const selectors = head.split(",").map((sel) => sel.trim())
  if (!selectors.every((sel) => PALETTE_SELECTOR.test(sel))) return null
  if (!selectors.some((sel) => sel.startsWith("[data-theme"))) return null
  const decls = new Map<string, string>()
  for (const m of body.matchAll(/(--[\w-]+|color-scheme):\s*([^;]+);/g)) decls.set(m[1], m[2].trim())
  return { media, selectors, decls }
}

/** Every rule whose selector is one of the palette selectors, with the
 *  `@media` it sits in. A block's braces are matched, so values with nested
 *  parentheses (light-dark(), rgba()) are kept whole. */
function paletteRules(css: string): Rule[] {
  const rules: Rule[] = []
  const walk = (src: string, media: string | null) => {
    let i = 0
    while (i < src.length) {
      const open = src.indexOf("{", i)
      if (open < 0) break
      const head = src.slice(i, open).trim()
      let depth = 0
      let close = open
      for (; close < src.length; close++) {
        if (src[close] === "{") depth++
        else if (src[close] === "}" && --depth === 0) break
      }
      const body = src.slice(open + 1, close)
      if (head.startsWith("@media")) walk(body, head)
      else if (!head.startsWith("@")) {
        const rule = paletteRule(head, body, media)
        if (rule) rules.push(rule)
      }
      i = close + 1
    }
  }
  walk(css, null)
  return rules
}

/** Split a function's arguments at top-level commas. */
function args(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++
    else if (value[i] === ")") depth--
    else if (value[i] === "," && depth === 0) {
      out.push(value.slice(from, i).trim())
      from = i + 1
    }
  }
  out.push(value.slice(from).trim())
  return out
}

/** Resolve a declared value for one scheme, the way the browser would. */
function resolve(value: string, scheme: Scheme): string {
  const m = value.match(/^light-dark\((.*)\)$/s)
  if (!m) return value
  const [light, dark, ...rest] = args(m[1])
  expect(rest, `light-dark() takes two colours: ${value}`).toHaveLength(0)
  expect(dark, `light-dark() is missing its dark side: ${value}`).toBeTruthy()
  return scheme === "light" ? light : dark
}

function matches(rule: Rule, ctx: (typeof CONTEXTS)[number]): boolean {
  const media = rule.media
  if (media && !media.includes(`prefers-color-scheme: ${ctx.os}`)) return false
  return rule.selectors.some((s) => {
    if (s === ":root" || s === "[data-theme]") return true
    return s === `[data-theme="${ctx.theme}"]`
  })
}

/** Every file's palette rules, in cascade order: globals.css, then the identity. */
const ALL_RULES = FILES.flatMap(({ css }) => paletteRules(css))

/** The color-scheme each context ends up with, from the same rules. */
function schemeOf(ctx: (typeof CONTEXTS)[number]): Scheme {
  let scheme: Scheme = "dark"
  for (const rule of ALL_RULES) {
    const cs = rule.decls.get("color-scheme")
    if (cs && matches(rule, ctx)) scheme = cs as Scheme
  }
  return scheme
}

/** The cascade for one context: globals.css, then glass-identity.css, later
 *  rules winning. The rule order within a file is the
 *  source order. */
function resolved(ctx: (typeof CONTEXTS)[number]): Map<string, string> {
  const scheme = schemeOf(ctx)
  const out = new Map<string, string>()
  for (const rule of ALL_RULES) {
    if (!matches(rule, ctx)) continue
    for (const [k, v] of rule.decls) if (k !== "color-scheme") out.set(k, resolve(v, scheme))
  }
  return out
}

/** Tokens light-dark() cannot carry (it takes colours only), so they keep a
 *  block per theme. */
const PER_THEME = /^--(shadow-|inset-shine|app-backdrop|glass-sheen)/

const ALL = new Set(ALL_RULES.flatMap((r) => [...r.decls.keys()]))
ALL.delete("color-scheme")

describe("colour tokens are written once with light-dark()", () => {
  it("finds the palette", () => {
    expect(ALL.size).toBeGreaterThan(60)
  })

  it.each(CONTEXTS)("every token resolves to a plain value in $name", (ctx) => {
    const tokens = resolved(ctx)
    for (const token of ALL) {
      const value = tokens.get(token)
      expect(value, `${token} is not defined in ${ctx.name}`).toBeTruthy()
      expect(value, `${token} left unresolved in ${ctx.name}`).not.toContain("light-dark(")
    }
  })

  it("defines every colour token in the shared block, never only in a theme's block", () => {
    // A token defined only in one theme's block is missing for the other theme.
    for (const token of ALL) {
      if (PER_THEME.test(token)) continue
      const sources = ALL_RULES
        .filter((r) => r.decls.has(token))
        .map((r) => r.selectors.join(","))
      expect(sources, `${token} only exists in a per-theme block`).toContain(":root,[data-theme]")
    }
  })

  it("keeps per-theme blocks for tokens light-dark() cannot carry, and nothing else", () => {
    for (const rule of ALL_RULES) {
      if (rule.selectors.join(",") === ":root,[data-theme]") continue
      const tokens = [...rule.decls.keys()].filter((t) => t !== "color-scheme")
      for (const token of tokens) {
        expect(token, `${rule.selectors.join(", ")} should hold only shadows and filters`).toMatch(PER_THEME)
      }
    }
  })

  it("picks the colour scheme from data-theme, and from the OS for system", () => {
    expect(schemeOf(CONTEXTS[0])).toBe("dark")
    expect(schemeOf(CONTEXTS[1])).toBe("light")
    expect(schemeOf(CONTEXTS[2])).toBe("light")
    expect(schemeOf(CONTEXTS[3])).toBe("dark")
  })

  it("resolves a different value on each side for the surfaces that must differ", () => {
    const dark = resolved(CONTEXTS[0])
    const light = resolved(CONTEXTS[1])
    for (const t of ["--bg", "--text-primary", "--accent", "--separator-opaque"]) {
      expect(light.get(t), t).not.toBe(dark.get(t))
    }
    // the OS decides system, and lands on the same palette as the explicit pick
    expect(resolved(CONTEXTS[2]).get("--bg")).toBe(light.get("--bg"))
    expect(resolved(CONTEXTS[3]).get("--bg")).toBe(dark.get("--bg"))
  })

  it("registers the tokens script reads back, so getComputedStyle returns a colour", () => {
    // An unregistered custom property reads back as the literal light-dark()
    // text, which a canvas gradient or a theme-color meta cannot use.
    const globals = FILES[0].css
    for (const token of [...PALETTE_TOKENS, "--bg"]) {
      expect(globals, `${token} is read by script but not registered`).toContain(`@property ${token} {`)
    }
  })
})
