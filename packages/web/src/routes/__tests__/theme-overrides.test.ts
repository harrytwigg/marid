import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { ACCENT_PRESETS } from "../settings/appearance-pickers"

const ROUTES = path.resolve(__dirname, "..")
const OVERRIDES = readFileSync(path.join(ROUTES, "theme-overrides.css"), "utf8")
const GLOBALS = readFileSync(path.join(ROUTES, "globals.css"), "utf8")
const MAIN = readFileSync(path.resolve(ROUTES, "../main.tsx"), "utf8")

const SCHEMES = ["dark", "light"] as const
type Scheme = (typeof SCHEMES)[number]

/** Both sides of a token's light-dark() pair, as written in `css`. The pair is
 *  the whole value, so a token is declared once and resolves in both schemes. */
function pair(css: string, name: string): Record<Scheme, string> {
  const m = css.match(new RegExp(`${name}:\\s*light-dark\\((.+)\\);`))
  expect(m, `${name} is not a light-dark() pair`).not.toBeNull()
  let depth = 0
  const v = m![1]
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "(") depth++
    else if (v[i] === ")") depth--
    else if (v[i] === "," && depth === 0) return { light: v.slice(0, i).trim(), dark: v.slice(i + 1).trim() }
  }
  throw new Error(`${name}: light-dark() needs two arguments`)
}

function side(name: string, scheme: Scheme): string {
  return pair(OVERRIDES, name)[scheme]
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

  it("re-declares the accent trio as one light-dark() pair each", () => {
    for (const t of ["--accent", "--accent-fill", "--accent-contrast"]) pair(OVERRIDES, t)
  })

  it("overrides tokens that exist upstream, and no accent is left amber", () => {
    for (const m of OVERRIDES.matchAll(/(--[\w-]+):/g)) {
      expect(GLOBALS, `${m[1]} is not an upstream token`).toContain(`${m[1]}:`)
    }
    expect(OVERRIDES).not.toMatch(/E0A33C|926516|B07A1A/i)
  })

  it("retints the talk orb and the light neutrals", () => {
    for (const t of ["--orb-core", "--orb-base", "--orb-bloom", "--orb-lobe-a", "--orb-lobe-b", "--orb-lobe-c", "--orb-shadow", "--orb-specular", "--orb-rim"]) {
      pair(OVERRIDES, t)
    }
    // upstream's warm orb (gold core/lobe) and warm-brown light neutrals must not survive
    expect(OVERRIDES).not.toMatch(/255,206,132|255,182,88|33,30,22|40,34,20/)
    for (const t of ["--fill-primary", "--separator", "--scrim", "--code-bg"]) pair(OVERRIDES, t)
    expect(OVERRIDES).toMatch(/--shadow-card:/)
  })

  it.each(SCHEMES)("meets WCAG AA for accent in %s", (scheme) => {
    const bg = side("--bg", scheme)
    const surface = side("--bg-secondary", scheme)
    const accent = side("--accent", scheme)
    const contrast = side("--accent-contrast", scheme)
    const { hex: fillHex, alpha } = hexOf(side("--accent-fill", scheme))
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
    for (const [mode, scheme] of [["DARK", "dark"], ["LIGHT", "light"]] as const) {
      const theme = term.slice(term.indexOf(`XTERM_THEME_${mode}: ITheme = {`)).split("};")[0]
      expect(theme).toContain(`background: "${side("--bg", scheme)}"`)
      expect(theme).toContain(`cursor: "${side("--accent", scheme)}"`)
    }
  })

  it("offers the default teal first in the accent picker", () => {
    expect(ACCENT_PRESETS[0]).toEqual({ label: "Marid teal", value: "#3DBFB2" })
    expect(side("--accent", "dark").toLowerCase()).toBe("#3dbfb2")
  })
})
