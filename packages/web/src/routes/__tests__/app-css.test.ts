import { readFileSync } from "node:fs"
import path from "node:path"

import postcss from "postcss"
import { describe, expect, it } from "vitest"

const ROUTES = path.resolve(__dirname, "..")
const root = postcss.parse(readFileSync(path.join(ROUTES, "app.css"), "utf8"))
const nodes = root.nodes.filter((node) => node.type !== "comment")
const isImport = (node: postcss.ChildNode): node is postcss.AtRule => node.type === "atrule" && node.name === "import"
const imports = nodes.filter(isImport).map((node) => node.params.replace(/\s.*$/, "").replace(/["']/g, ""))

describe("app.css", () => {
  // CSS drops an @import that follows any rule, without a warning, so a rule
  // added in the wrong place deletes the palette and the bridge below it.
  it("has every @import before its first rule", () => {
    const lastImport = nodes.findLastIndex(isImport)
    const firstRule = nodes.findIndex((node) => !isImport(node))

    expect(firstRule === -1 || firstRule > lastImport, `a rule precedes the import at ${lastImport}`).toBe(true)
  })

  it("loads the bridge after HeroUI's theme so it wins on source order", () => {
    const order = ["./globals.css", "heroui-theme-map", "./heroui-bridge.css"].map((file) =>
      imports.indexOf(file),
    )

    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  // HeroUI's base layer sets this to none, which ends the route-change
  // cross-fade styled in globals.css. A browser would be needed to see it, so
  // the last word on it is read from the source.
  it("ends with the root taking part in view transitions", () => {
    let name: string | undefined
    root.walkRules(":root", (rule) =>
      rule.walkDecls("view-transition-name", (decl) => {
        name = decl.value
      }),
    )

    expect(name).toBe("root")
  })
})
