import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(__dirname, "..", "..", "..")
const read = (path: string) => readFileSync(join(root, path))
const text = (path: string) => read(path).toString("utf8")

const SVGS = [
  "public/icons/marid-mark.svg",
  "public/icons/marid-mark-maskable.svg",
  "public/icons/marid-mark-mono.svg",
  "public/icons/marid-favicon.svg",
]

const png = (path: string) => {
  const buf = read(path)
  expect(buf.subarray(1, 4).toString("ascii"), path).toBe("PNG")
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe("brand assets", () => {
  it.each(SVGS)("%s carries no letters, titles or editor metadata", (path) => {
    const svg = text(path)
    expect(svg).not.toMatch(/<text|<title|<desc|<metadata|<!--|inkscape|sodipodi|aria-label|role=/i)
  })

  it.each([
    ["public/icons/icon-192.png", 192],
    ["public/icons/icon-512.png", 512],
    ["public/icons/icon-maskable-512.png", 512],
    ["public/apple-touch-icon.png", 180],
    ["public/icons/favicon-32.png", 32],
  ])("%s is %i px square", (path, size) => {
    expect(png(path)).toEqual({ width: size, height: size })
  })

  it("keeps the maskable tile full-bleed", () => {
    expect(text("public/icons/marid-mark-maskable.svg")).not.toContain("rx=")
  })

  it("takes the manifest colours from the dark sheet of the glass palette", () => {
    const css = text("src/routes/glass-identity.css")
    const [, light, dark] = /--bg: light-dark\((#[0-9A-Fa-f]{6}), (#[0-9A-Fa-f]{6})\)/.exec(css) ?? []
    expect(dark).toBeTruthy()
    const manifest = JSON.parse(text("public/manifest.webmanifest"))
    expect(manifest.background_color.toLowerCase()).toBe(dark.toLowerCase())
    expect(manifest.theme_color.toLowerCase()).toBe(dark.toLowerCase())

    const html = text("index.html")
    expect(html).toContain(`<meta name="theme-color" content="${light.toUpperCase()}" media="(prefers-color-scheme: light)" />`)
    expect(html).toContain(`<meta name="theme-color" content="${dark.toUpperCase()}" media="(prefers-color-scheme: dark)" />`)
  })

  it("points the tab icon at the lead delta, with a PNG fallback", () => {
    const html = text("index.html")
    expect(html).toContain('href="/icons/marid-favicon.svg"')
    expect(html).toContain('href="/icons/favicon-32.png"')
  })

  it("declares the three install icons the manifest needs", () => {
    const { icons } = JSON.parse(text("public/manifest.webmanifest"))
    expect(icons.map((i: { src: string; purpose: string }) => [i.src, i.purpose])).toEqual([
      ["/icons/icon-192.png", "any"],
      ["/icons/icon-512.png", "any"],
      ["/icons/icon-maskable-512.png", "maskable"],
    ])
  })
})
