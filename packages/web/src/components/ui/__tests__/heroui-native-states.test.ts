import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { describe, expect, it } from "vitest"

/*
 * Button, Switch, Input and Textarea are native elements that rely on HeroUI's
 * stylesheet answering the browser's own states (:hover, :active, :focus-visible,
 * :disabled) beside the data-* forms React Aria would set. jsdom cannot see a
 * stylesheet, so this pins that the installed HeroUI CSS still does: an upgrade
 * that dropped a native selector would leave those controls without a ring or a
 * pressed state, and nothing else would notice.
 */
const stylesDir = path.dirname(createRequire(import.meta.url).resolve("@heroui/styles/package.json"))
const css = (name: string) => readFileSync(path.join(stylesDir, "dist/components", `${name}.css`), "utf8")

describe("HeroUI's stylesheets answer the browser's own states", () => {
  it("button: hover, pressed, focus ring and disabled", () => {
    const button = css("button")
    expect(button).toContain("&:focus-visible")
    expect(button).toContain("&:active")
    expect(button).toContain("&:disabled")
    expect(button).toMatch(/&:hover|:hover/)
  })

  it("switch: selected (also by aria-checked), disabled, hover and pressed on the root", () => {
    const sw = css("switch")
    expect(sw).toContain('.switch[aria-checked="true"]')
    expect(sw).toContain('.switch[data-selected="true"]')
    expect(sw).toContain('&[data-disabled="true"]')
    expect(sw).toContain(".switch:hover")
    expect(sw).toContain(".switch:active")
  })

  it("input and textarea: hover, focus and disabled", () => {
    for (const name of ["input", "textarea"]) {
      const field = css(name)
      expect(field, name).toContain("&:hover")
      expect(field, name).toContain("&:focus")
      expect(field, name).toContain("&:disabled")
    }
  })
})
