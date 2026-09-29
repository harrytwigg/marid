import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { ACCENT_PRESETS } from "../settings/appearance-pickers"

const ROUTES = path.resolve(__dirname, "..")
const OVERRIDES = readFileSync(path.join(ROUTES, "theme-overrides.css"), "utf8")
const GLOBALS = readFileSync(path.join(ROUTES, "globals.css"), "utf8")
const MAIN = readFileSync(path.resolve(ROUTES, "../main.tsx"), "utf8")

/** The four selectors globals.css declares its theme tokens under, in the order
 *  it declares them. The override file must restate the accent for each. */
const BLOCKS = [
  { name: "dark", opener: ':root, [data-theme="dark"] {', mode: "dark" },
  { name: "light", opener: '[data-theme="light"] {', mode: "light" },
  { name: "system-light", opener: '@media (prefers-color-scheme: light) {', mode: "light" },
  { name: "system-dark", opener: '@media (prefers-color-scheme: dark) {', mode: "dark" },
] as const

function block(css: string, opener: string): string {
  const start = css.indexOf(opener)
  expect(start, `${opener} not found`).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++
    if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1)
  }
  throw new Error(`unbalanced block: ${opener}`)
}

function token(body: string, name: string): string {
  const m = body.match(new RegExp(`${name}:\\s*([^;]+);`))
  expect(m, `${name} missing`).not.toBeNull()
  return m![1].trim()
}

const lin = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
function hexOf(rgba: string): { hex: string; alpha: number } {
  const [r, g, b, a] = rgba.match(/[\d.]+/g)!.map(Number)
  const h = (n: number) => n.toString(16).padStart(2, "0")
  return { hex: `#${h(r)}${h(g)}${h(b)}`, alpha: a }
}
function over(fg: string, alpha: number, bg: string): string {
  const f = parseInt(fg.slice(1), 16)
  const b = parseInt(bg.slice(1), 16)
  const c = (s: number) => Math.round(((f >> s) & 255) * alpha + ((b >> s) & 255) * (1 - alpha))
  return `#${[16, 8, 0].map((s) => c(s).toString(16).padStart(2, "0")).join("")}`
}

describe("theme-overrides.css", () => {
  it("is imported after globals.css so it wins on source order", () => {
    const g = MAIN.indexOf("./routes/globals.css")
    const o = MAIN.indexOf("./routes/theme-overrides.css")
    expect(g).toBeGreaterThanOrEqual(0)
    expect(o).toBeGreaterThan(g)
  })

  it("re-declares the accent trio in all four theme blocks", () => {
    for (const { name, opener } of BLOCKS) {
      const body = block(OVERRIDES, opener)
      for (const t of ["--accent", "--accent-fill", "--accent-contrast"]) {
        expect(body, `${name} missing ${t}`).toMatch(new RegExp(`${t}:`))
      }
    }
  })

  it("overrides blocks that exist upstream, and no accent is left amber", () => {
    for (const { opener } of BLOCKS) block(GLOBALS, opener)
    expect(OVERRIDES).not.toMatch(/E0A33C|926516|B07A1A/i)
  })

  it("retints the talk orb and the light neutrals in every block", () => {
    for (const { name, opener } of BLOCKS) {
      const body = block(OVERRIDES, opener)
      for (const t of ["--orb-core", "--orb-base", "--orb-bloom", "--orb-lobe-a", "--orb-lobe-b", "--orb-lobe-c", "--orb-shadow", "--orb-specular", "--orb-rim"]) {
        expect(body, `${name} missing ${t}`).toMatch(new RegExp(`${t}:`))
      }
    }
    // upstream's warm orb (gold core/lobe) and warm-brown light neutrals must not survive
    expect(OVERRIDES).not.toMatch(/255,206,132|255,182,88|33,30,22|40,34,20/)
    for (const { name, opener } of BLOCKS.filter((b) => b.mode === "light")) {
      const body = block(OVERRIDES, opener)
      for (const t of ["--fill-primary", "--separator", "--scrim", "--shadow-card", "--code-bg"]) {
        expect(body, `${name} missing ${t}`).toMatch(new RegExp(`${t}:`))
      }
    }
  })

  it.each(BLOCKS)("meets WCAG AA for accent in $name", ({ opener }) => {
    const body = block(OVERRIDES, opener)
    const bg = token(body, "--bg")
    const surface = token(body, "--bg-secondary")
    const accent = token(body, "--accent")
    const contrast = token(body, "--accent-contrast")
    const { hex: fillHex, alpha } = hexOf(token(body, "--accent-fill"))
    // accent text on the page and on cards
    expect(ratio(accent, bg)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(accent, surface)).toBeGreaterThanOrEqual(4.5)
    // text on a solid accent fill (buttons)
    expect(ratio(contrast, accent)).toBeGreaterThanOrEqual(4.5)
    // accent text on its own translucent fill (selected rows, chips)
    expect(ratio(accent, over(fillHex, alpha, bg))).toBeGreaterThanOrEqual(4.5)
    // the fill token is the accent at low alpha, not a different colour
    expect(fillHex).toBe(accent.toLowerCase())
  })

  it("keeps the xterm palettes on the overridden --bg and --accent", () => {
    const term = readFileSync(path.resolve(ROUTES, "../components/cli-terminal.tsx"), "utf8")
    for (const [mode, opener] of [["DARK", BLOCKS[0].opener], ["LIGHT", BLOCKS[1].opener]] as const) {
      const theme = term.slice(term.indexOf(`XTERM_THEME_${mode}: ITheme = {`)).split("};")[0]
      const body = block(OVERRIDES, opener)
      expect(theme).toContain(`background: "${token(body, "--bg")}"`)
      expect(theme).toContain(`cursor: "${token(body, "--accent")}"`)
    }
  })

  it("offers the default teal first in the accent picker", () => {
    expect(ACCENT_PRESETS[0]).toEqual({ label: "Marid teal", value: "#3DBFB2" })
    expect(token(block(OVERRIDES, BLOCKS[0].opener), "--accent").toLowerCase()).toBe("#3dbfb2")
  })
})
