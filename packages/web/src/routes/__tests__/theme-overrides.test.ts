import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const ROUTES = path.resolve(__dirname, "..")
const OVERRIDES = readFileSync(path.join(ROUTES, "theme-overrides.css"), "utf8")
const GLOBALS = readFileSync(path.join(ROUTES, "globals.css"), "utf8")
const MAIN = readFileSync(path.resolve(ROUTES, "../main.tsx"), "utf8")

const ORB = ["--orb-core", "--orb-base", "--orb-bloom", "--orb-lobe-a", "--orb-lobe-b", "--orb-lobe-c", "--orb-shadow", "--orb-specular", "--orb-rim"]

describe("theme-overrides.css", () => {
  it("is imported after globals.css so it wins on source order", () => {
    const g = MAIN.indexOf("./routes/globals.css")
    const o = MAIN.indexOf("./routes/theme-overrides.css")
    expect(g).toBeGreaterThanOrEqual(0)
    expect(o).toBeGreaterThan(g)
  })

  it("holds the talk orb palette, each token as one light-dark() pair", () => {
    for (const token of ORB) expect(OVERRIDES, token).toMatch(new RegExp(`${token}:\\s*light-dark\\(.+\\);`))
  })

  it("overrides only tokens that exist upstream, and only the orb's", () => {
    const declared = [...OVERRIDES.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+):/g)].map((m) => m[1])
    expect(declared.sort()).toEqual([...ORB].sort())
    for (const token of declared) expect(GLOBALS, `${token} is not an upstream token`).toContain(`${token}:`)
  })

  it("leaves no upstream warm orb colour behind", () => {
    expect(OVERRIDES).not.toMatch(/255,206,132|255,182,88/)
  })
})
