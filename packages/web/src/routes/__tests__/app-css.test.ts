import { readFileSync } from "node:fs"
import path from "node:path"

import postcss from "postcss"
import { describe, expect, it } from "vitest"

const ROUTES = path.resolve(__dirname, "..")
const APP_CSS = readFileSync(path.join(ROUTES, "app.css"), "utf8")

describe("app.css", () => {
  // CSS drops an @import that follows any rule, without a warning, so a rule
  // added in the wrong place deletes the palette and the bridge below it.
  it("has every @import before its first rule", () => {
    const nodes = postcss.parse(APP_CSS).nodes.filter((node) => node.type !== "comment")
    const firstRule = nodes.findIndex((node) => !(node.type === "atrule" && node.name === "import"))
    const lateImports = nodes.slice(firstRule).filter((node) => node.type === "atrule" && node.name === "import")

    expect(lateImports.map((node) => node.toString())).toEqual([])
  })

  it("loads the palette and the bridge after HeroUI's theme so they win on source order", () => {
    const order = ["./globals.css", "heroui-theme-map", "./theme-overrides.css", "./heroui-bridge.css"].map((file) =>
      APP_CSS.indexOf(`"${file}"`),
    )

    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})
