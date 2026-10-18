import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { ACCENT_PRESETS } from "../settings/appearance-pickers"

const ROUTES = path.resolve(__dirname, "..")
const IDENTITY = readFileSync(path.join(ROUTES, "glass-identity.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

type Scheme = "dark" | "light"
const SCHEMES: Scheme[] = ["light", "dark"]

type Rgba = { r: number; g: number; b: number; a: number }

/** The body of the first rule whose selector is exactly `selector`, braces matched. */
function ruleBody(css: string, selector: string): string {
  const head = css.indexOf(`${selector} {`)
  expect(head, `${selector} is not in glass-identity.css`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf("{", head)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i)
  }
  throw new Error(`${selector}: unbalanced braces`)
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(m[1], m[2].trim().replace(/\s+/g, " "))
  return out
}

/** Split at top-level commas. */
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

const SHARED = declarations(ruleBody(IDENTITY, ":root, [data-theme]"))
const LIGHT_BLOCK = declarations(ruleBody(IDENTITY, '[data-theme="light"]'))

/** A token's value for one scheme: the light-dark() side, with var() followed. */
function token(name: string, scheme: Scheme, own?: Map<string, string>): string {
  const raw = own?.get(name) ?? SHARED.get(name)
  expect(raw, `${name} is not declared by the identity`).toBeTruthy()
  let value = raw!
  const ref = value.match(/^var\((--[\w-]+)\)$/)
  if (ref) return token(ref[1], scheme, own)
  const pair = value.match(/^light-dark\((.*)\)$/)
  if (pair) {
    const [light, dark, ...rest] = args(pair[1])
    expect(rest, `${name}: light-dark() takes two colours`).toHaveLength(0)
    value = scheme === "light" ? light : dark
  }
  return value
}

function parseColour(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1]
    const n = parseInt(h, 16)
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  const fn = value.match(/^rgba?\(([^)]+)\)$/)
  expect(fn, `not a colour the contrast test can read: ${value}`).not.toBeNull()
  const [r, g, b, a = 1] = fn![1].split(",").map((p) => Number(p.trim()))
  return { r, g, b, a }
}

function colour(name: string, scheme: Scheme): Rgba {
  return parseColour(token(name, scheme))
}

/** `top` painted over `under`; `under` must be opaque. */
function over(top: Rgba, under: Rgba): Rgba {
  const mix = (t: number, u: number) => t * top.a + u * (1 - top.a)
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 }
}

const lin = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const lum = (c: Rgba) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The opaque colours the ambient backdrop can show under a surface: both ends
 * of the vertical gradient, and each radial pool's centre painted over either
 * end. The centre is the pool's strongest colour and its ends bracket what it
 * sits on, so these are the extremes of every pixel the backdrop can produce.
 */
function backdropStops(scheme: Scheme): Rgba[] {
  const value = (scheme === "light" ? LIGHT_BLOCK : SHARED).get("--app-backdrop")
  expect(value, `--app-backdrop for ${scheme}`).toBeTruthy()
  // The backdrop is a comma-separated list of gradients; split it on the
  // commas that sit between one gradient's closing paren and the next name.
  const gradients = value!.split(/,\s*(?=(?:radial|linear)-gradient\()/)
  const linear = gradients.find((g) => g.startsWith("linear-gradient"))
  expect(linear, "a vertical gradient under the pools").toBeTruthy()
  const ends = [...linear!.matchAll(/(#[0-9a-f]{6})\s+\d+%/gi)].map((m) => parseColour(m[1]))
  expect(ends).toHaveLength(2)
  const pools = gradients
    .filter((g) => g.startsWith("radial-gradient"))
    .map((g) => {
      const first = g.match(/(#[0-9a-f]{6}|rgba?\([^)]+\))\s+0%/i)
      expect(first, `a pool with a colour at 0%: ${g}`).not.toBeNull()
      return parseColour(first![1])
    })
  expect(pools.length).toBeGreaterThanOrEqual(3)
  return [...ends, ...pools.flatMap((pool) => ends.map((end) => over(pool, end)))]
}

/** The gloss laid over the chat list panel, at its strongest (the top edge). */
function sheen(scheme: Scheme): Rgba {
  const value = (scheme === "light" ? LIGHT_BLOCK : SHARED).get("--glass-sheen")
  const m = value?.match(/(rgba\([^)]+\))\s+0%/)
  expect(m, `--glass-sheen for ${scheme}`).not.toBeNull()
  return parseColour(m![1])
}

const TEXT = ["--text-primary", "--text-secondary", "--text-tertiary"] as const
// --text-quaternary is for placeholders and disabled controls, which WCAG
// exempts; it is not checked.
const TINTS = ["--glass-chrome", "--glass-float", "--glass-overlay"] as const
const AA = 4.5

/** Every surface text can sit on for a scheme, as { label, colour }. */
function surfaces(scheme: Scheme): { label: string; colour: Rgba }[] {
  const out: { label: string; colour: Rgba }[] = []
  const gloss = sheen(scheme)
  backdropStops(scheme).forEach((stop, i) => {
    for (const tint of TINTS) {
      const tinted = over(colour(tint, scheme), stop)
      out.push({ label: `${tint} over backdrop stop ${i + 1}`, colour: tinted })
      if (tint === "--glass-chrome") out.push({ label: `${tint} with its sheen over backdrop stop ${i + 1}`, colour: over(gloss, tinted) })
    }
  })
  for (const opaque of ["--glass-chrome-opaque", "--glass-float-opaque", "--glass-overlay-opaque", "--glass-sheet-opaque"]) {
    out.push({ label: opaque, colour: colour(opaque, scheme) })
  }
  return out
}

describe.each(SCHEMES)("contrast of the glass identity in %s", (scheme) => {
  const grounds = surfaces(scheme)

  it("finds the backdrop stops and every surface", () => {
    expect(backdropStops(scheme).length).toBeGreaterThanOrEqual(6)
    // 3 tints plus the chrome sheen over each stop, and 4 opaque twins
    expect(grounds.length).toBe(backdropStops(scheme).length * 4 + 4)
  })

  it.each(TEXT)("%s reads on every surface at AA", (name) => {
    for (const { label, colour: ground } of grounds) {
      const fg = over(colour(name, scheme), ground)
      expect(ratio(fg, ground), `${name} on ${label}`).toBeGreaterThanOrEqual(AA)
    }
  })

  it("accent text reads on every surface at AA", () => {
    for (const { label, colour: ground } of grounds) {
      expect(ratio(colour("--accent", scheme), ground), `--accent on ${label}`).toBeGreaterThanOrEqual(AA)
    }
  })

  it("text on the accent fill reads at AA", () => {
    expect(ratio(colour("--accent-contrast", scheme), colour("--accent", scheme))).toBeGreaterThanOrEqual(AA)
  })

  it("accent text reads on its own translucent fill over the sheet", () => {
    const sheet = colour("--glass-sheet-opaque", scheme)
    const fill = over(colour("--accent-fill", scheme), sheet)
    expect(ratio(colour("--accent", scheme), fill)).toBeGreaterThanOrEqual(AA)
  })

  it("the sheet is the page colour inside it, so sticky headers and scrims match it", () => {
    const sheet = declarations(ruleBody(IDENTITY, '[data-shell="sheet"]'))
    expect(sheet.get("--bg")).toBe("var(--glass-sheet-opaque)")
    expect(sheet.get("--material-thick")).toBe("var(--glass-sheet-opaque)")
    expect(sheet.get("--material-thick-opaque")).toBe("var(--glass-sheet-opaque)")
    expect(parseColour(token("--glass-sheet-opaque", scheme)).a).toBe(1)
  })
})

describe("reduced transparency", () => {
  const TOKENS = ["--glass-chrome", "--glass-float", "--glass-overlay", "--glass-sheet"]

  it("swaps every tint for its opaque twin and drops blur, from the OS and from the attribute", () => {
    const media = IDENTITY.slice(IDENTITY.indexOf("@media (prefers-reduced-transparency: reduce)"))
    const fromOs = declarations(ruleBody(media, ":root, [data-theme]"))
    const fromAttribute = declarations(ruleBody(IDENTITY, '[data-transparency="reduced"], [data-transparency="reduced"] [data-theme]'))
    for (const decls of [fromOs, fromAttribute]) {
      for (const name of TOKENS) expect(decls.get(name), name).toBe(`var(${name}-opaque)`)
      expect(decls.get("--glass-blur")).toBe("none")
      expect(decls.get("--glass-blur-strong")).toBe("none")
    }
  })

  it.each(SCHEMES)("has an opaque twin for every tint in %s", (scheme) => {
    for (const name of TOKENS) expect(parseColour(token(`${name}-opaque`, scheme)).a, `${name}-opaque`).toBe(1)
  })
})

describe("the shell", () => {
  it("is loaded after globals.css and theme-overrides.css so it wins on source order", () => {
    // main.tsx loads the one stylesheet root, which pulls globals.css and then
    // theme-overrides.css in; the identity comes after the whole root.
    const main = readFileSync(path.resolve(ROUTES, "../main.tsx"), "utf8")
    const root = readFileSync(path.resolve(ROUTES, "app.css"), "utf8")
    const imports = ["app.css", "glass-identity.css"].map((f) => main.indexOf(`./routes/${f}`))
    expect(imports[0]).toBeGreaterThanOrEqual(0)
    expect(imports[1]).toBeGreaterThan(imports[0])
    const inRoot = ["globals.css", "theme-overrides.css"].map((f) => root.indexOf(`@import "./${f}"`))
    expect(inRoot[0]).toBeGreaterThanOrEqual(0)
    expect(inRoot[1]).toBeGreaterThan(inRoot[0])
  })

})

/** Top-level @media blocks of a stylesheet, with the stylesheet minus them. */
function splitMedia(css: string): { rest: string; blocks: Array<{ query: string; body: string }> } {
  const blocks: Array<{ query: string; body: string }> = []
  let rest = ""
  let i = 0
  while (i < css.length) {
    const at = css.indexOf("@media", i)
    if (at < 0) break
    rest += css.slice(i, at)
    const open = css.indexOf("{", at)
    let depth = 0
    let end = open
    for (; end < css.length; end++) {
      if (css[end] === "{") depth++
      else if (css[end] === "}" && --depth === 0) break
    }
    blocks.push({ query: css.slice(at + 6, open).trim(), body: css.slice(open + 1, end) })
    i = end + 1
  }
  return { rest: rest + css.slice(i), blocks }
}

describe("floating glass", () => {
  const { rest, blocks } = splitMedia(IDENTITY)
  const MAX_RADIUS = 32

  it("keeps every blur radius within 32px, in the tokens and anywhere else", () => {
    const radii = [...IDENTITY.matchAll(/blur\((\d+(?:\.\d+)?)px\)/g)].map((m) => Number(m[1]))
    expect(radii.length).toBeGreaterThan(0)
    for (const radius of radii) expect(radius).toBeLessThanOrEqual(MAX_RADIUS)
  })

  it("applies a backdrop filter only for a fine pointer, so a coarse pointer gets the opaque tint", () => {
    // Outside a media query a filter may only be switched off (the several-panes rule).
    for (const m of rest.matchAll(/backdrop-filter:\s*([^;]+);/g)) expect(m[1].trim()).toBe("none")
    for (const block of blocks.filter((b) => /backdrop-filter/.test(b.body))) {
      expect(block.query).toContain("pointer: fine")
    }
    expect(ruleBody(rest, ".glass-float, .glass-float-bar, .glass-tint, .glass-tint-bar")).toMatch(/background:\s*var\(--glass-float-opaque\)/)
  })

  it("filters through the blur token, which reduced transparency sets to none", () => {
    const fine = blocks.filter((b) => b.query.includes("pointer: fine"))
    const filters = fine.flatMap((b) => [...b.body.matchAll(/(?<!-webkit-)backdrop-filter:\s*([^;]+);/g)].map((m) => m[1].trim()))
    expect(filters.length).toBeGreaterThan(0)
    // Anything but `none` goes through a token that Reduced sets to none: the surface blur or,
    // for an overlay, the strong one; `none` only switches a surface off.
    for (const value of filters.filter((v) => v !== "none")) expect(["var(--glass-blur)", "var(--glass-blur-strong)"]).toContain(value)
  })

  it("draws an overlay as the overlay tint with the strong blur and the overlay shadow, opaque for a coarse pointer", () => {
    expect(ruleBody(rest, ".glass-overlay")).toMatch(/background:\s*var\(--glass-overlay-opaque\)/)
    expect(ruleBody(rest, ".glass-overlay")).toMatch(/box-shadow:\s*var\(--shadow-overlay\)/)
    const fine = blocks.find((b) => b.query.includes("pointer: fine") && b.body.includes(".glass-overlay"))!
    const body = ruleBody(fine.body, ".glass-overlay")
    expect(body).toMatch(/background:\s*var\(--glass-overlay\)/)
    expect(body).toMatch(/(?<!-webkit-)backdrop-filter:\s*var\(--glass-blur-strong\)/)
  })

  it("blurs the nav rail's label only while it shows, so one label is one blurred surface", () => {
    expect(rest).not.toMatch(/\.rail-reveal\s*\{[^}]*backdrop-filter/)
    const fine = blocks.find((b) => b.query.includes("pointer: fine") && b.body.includes(".rail-reveal"))!
    expect(fine.body).toMatch(/\.group\\\/row:is\(:hover, :focus-within\) \.rail-reveal\s*\{[^}]*backdrop-filter:\s*var\(--glass-blur-strong\)/)
  })

  it("scales geometry and gradients with --glass-live: 1 normally, 0 under reduced transparency", () => {
    expect(SHARED.get("--glass-live")).toBe("1")
    const media = IDENTITY.slice(IDENTITY.indexOf("@media (prefers-reduced-transparency: reduce)"))
    const fromOs = declarations(ruleBody(media, ":root, [data-theme]"))
    const fromAttribute = declarations(ruleBody(IDENTITY, '[data-transparency="reduced"], [data-transparency="reduced"] [data-theme]'))
    expect(fromOs.get("--glass-live")).toBe("0")
    expect(fromAttribute.get("--glass-live")).toBe("0")
  })

  it("lets the composer overlap the transcript only with the glass live and a fine pointer", () => {
    const floats = blocks.find((b) => b.query === "(pointer: fine)" && b.body.includes("--composer-overlap"))
    expect(floats, "the composer's pointer: fine block").toBeTruthy()
    expect(declarations(ruleBody(rest, "[data-composer-float]")).get("--composer-overlap")).toBe("0px")
    expect(declarations(ruleBody(floats!.body, "[data-composer-float]")).get("--composer-overlap")).toBe("calc(var(--glass-live) * 56px)")
  })

  it("lets the empty parts of the composer band pass the wheel and clicks to the text under it", () => {
    const fine = blocks.find((b) => b.query === "(pointer: fine)" && b.body.includes("--composer-overlap"))!
    const bandRule = ruleBody(fine.body, "[data-composer-float] [data-chat-composer],\n  [data-composer-float] [data-chat-composer-measure]")
    expect(bandRule).toMatch(/pointer-events:\s*none/)
    expect(ruleBody(fine.body, "[data-composer-float] [data-chat-composer-measure] > *")).toMatch(/pointer-events:\s*auto/)
  })

  it("keeps the several-panes tint behind a fine pointer, so a coarse pointer stays opaque", () => {
    expect(rest).toMatch(/\[data-chat-multi-pane\] \.glass-float \{[^}]*backdrop-filter:\s*none/)
    expect(rest).not.toMatch(/\[data-chat-multi-pane\] \.glass-float \{[^}]*background/)
    const fine = blocks.find((b) => b.query === "(pointer: fine)" && b.body.includes("[data-chat-multi-pane]"))
    expect(fine, "the multi-pane tint's pointer: fine block").toBeTruthy()
  })

  it("keeps the plain fade on the top scrim in a CLI view", () => {
    const fine = blocks.find((b) => b.query === "(pointer: fine)" && b.body.includes("[data-chat-top-scrim]"))!
    expect(fine.body).toContain("[data-chat-top-scrim]:not([data-chat-scrim-flat])")
    expect(fine.body).not.toMatch(/\[data-chat-top-scrim\] \{/)
  })

  it("lets the loading ring win over the float shadow", () => {
    const fine = blocks.find((b) => b.query === "(pointer: fine)" && b.body.includes("composer-card-loading"))
    expect(fine, "the loading ring rule").toBeTruthy()
  })

  it("is tint only on the top scrim below lg, where the header bar is the blurred surface", () => {
    const narrow = blocks.find((b) => b.query.includes("max-width") && b.body.includes("[data-chat-top-scrim]"))
    expect(narrow, "the narrow scrim block").toBeTruthy()
    expect(declarations(ruleBody(narrow!.body, "[data-chat-top-scrim]:not([data-chat-scrim-flat])").replace(/opacity:\s*([^;]+);/, "--opacity: $1;")).get("--opacity")).toBe("calc(1 - var(--glass-live))")
  })
})

describe("things that mirror the identity", () => {
  it.each(SCHEMES)("keeps the xterm palette on the sheet, the ink and the system colours in %s", (scheme) => {
    const term = readFileSync(path.resolve(ROUTES, "../components/cli-terminal.tsx"), "utf8")
    const theme = term.slice(term.indexOf(`XTERM_THEME_${scheme.toUpperCase()}: ITheme = {`)).split("};")[0]
    const hex = (name: string) => token(name, scheme).toUpperCase()
    expect(theme).toContain(`background: "${hex("--glass-sheet-opaque")}"`)
    expect(theme).toContain(`foreground: "${hex("--text-primary")}"`)
    expect(theme).toContain(`cursor: "${hex("--accent")}"`)
    for (const [ansi, name] of [["red", "--system-red"], ["green", "--system-green"], ["yellow", "--system-yellow"], ["blue", "--system-blue"], ["magenta", "--system-purple"]]) {
      expect(theme, ansi).toContain(`${ansi}: "${hex(name)}"`)
    }
  })

  it("offers the theme's own accent first, as a swatch that clears the override", () => {
    // A picked swatch is written inline on <html> and replaces the light-dark()
    // pair, so a single colour must read on both sheets; the default is the
    // pair itself.
    expect(ACCENT_PRESETS[0]).toEqual({ label: "Default", value: null })
  })
})

describe.each(SCHEMES)("system colours in %s", (scheme) => {
  const SYSTEM = ["--system-blue", "--system-indigo", "--system-green", "--system-red", "--system-orange", "--system-yellow", "--system-purple"]

  it.each(SYSTEM)("%s reads as text on every glass tint, the backdrop stops and the sheet at AA", (name) => {
    for (const { label, colour: ground } of surfaces(scheme)) {
      expect(ratio(colour(name, scheme), ground), `${name} on ${label}`).toBeGreaterThanOrEqual(AA)
    }
  })
})
