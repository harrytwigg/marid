import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const SRC = path.resolve(__dirname, "../../..")

function source(relative: string): string {
  return readFileSync(path.join(SRC, relative), "utf8")
}

const GLOBALS = source("routes/globals.css")

/** Every file this change touched, listed by hand. A tree-wide grep would fail
 *  on surfaces nobody has migrated yet and turn this guard into noise. */
const TOUCHED = [
  "components/ui/dialog.tsx",
  "components/ui/dropdown-menu.tsx",
  "components/ui/select.tsx",
  "components/ui/context-menu.tsx",
  "routes/todos/todo-dialog.tsx",
  "routes/todos/new-todo-dialog.tsx",
  "routes/todos/todo-filter-sheet.tsx",
  "components/pill-nav.tsx",
  "components/chat/mobile-tab-bar.tsx",
  "components/chat/chat-tabs.tsx",
]

/** The subset of those that open and close, and so owe both halves. */
const OVERLAYS = TOUCHED.slice(0, 7)

const DURATION_TOKENS = ["--duration-instant", "--duration-fast", "--duration-base", "--duration-slow"]

/** The utility names shadcn's markup ships with. They come from the
 *  tw-animate-css plugin, which is not a dependency here and is not imported,
 *  so every one of them emitted exactly nothing. This is the guard that would
 *  have caught that. */
const PLUGIN_CLASSES = [
  "animate-in",
  "animate-out",
  "fade-in-0",
  "fade-out-0",
  "zoom-in-",
  "zoom-out-",
  "slide-in-from-",
  "slide-out-to-",
]

function themeBlock(): string {
  // The bare @theme, not @theme inline — the character class stops at the first
  // brace, and neither block nests one.
  const match = GLOBALS.match(/@theme\s*\{([^}]*)\}/)
  if (!match) throw new Error("globals.css has no @theme block")
  return match[1]
}

function reducedMotionRoot(): string {
  const match = GLOBALS.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*:root\s*\{([^}]*)\}/)
  if (!match) throw new Error("globals.css has no reduced-motion :root block")
  return match[1]
}

function valuesOf(css: string, property: string): string[] {
  return [...css.matchAll(new RegExp(`${property}:\\s*([^;]+);`, "g"))].map((m) => m[1].trim())
}

/** The motion keyframes are one-liners, so the body is everything between the
 *  first and last brace on their line. */
function keyframeBody(name: string): string {
  const match = GLOBALS.match(new RegExp(`^@keyframes\\s+${name}\\s*\\{(.*)\\}\\s*$`, "m"))
  if (!match) throw new Error(`globals.css defines no single-line @keyframes ${name}`)
  return match[1]
}

/** `motion-safe:data-[state=open]:animate-pop-in` → `pop-in`. */
function animationsFor(file: string, state: "open" | "closed"): string[] {
  const pattern = new RegExp(`data-\\[state=${state}\\]:animate-([a-z-]+)`, "g")
  return [...source(file).matchAll(pattern)].map((m) => m[1])
}

describe("motion tokens", () => {
  it("declares the duration scale once, in the @theme block", () => {
    const theme = themeBlock()
    for (const token of DURATION_TOKENS) {
      const literals = valuesOf(GLOBALS, token).filter((value) => !value.startsWith("var("))
      expect(literals, `${token} should have exactly one literal declaration`).toHaveLength(1)
      expect(valuesOf(theme, token)).toEqual(literals)
    }
  })

  it("collapses the scale under reduced motion rather than switching motion off", () => {
    // An `animation: none` would leave a view transition with nothing to end,
    // and its snapshot frozen over the live page.
    const collapsed = reducedMotionRoot()
    for (const token of DURATION_TOKENS.filter((t) => t !== "--duration-instant")) {
      expect(valuesOf(collapsed, token)).toEqual(["var(--duration-instant)"])
    }
    expect(collapsed).not.toContain("animation: none")
  })

  it("points every animation token at a keyframe that exists", () => {
    const tokens = [...themeBlock().matchAll(/--animate-[a-z-]+:\s*([a-zA-Z][\w-]*)/g)].map((m) => m[1])
    expect(tokens.length).toBeGreaterThan(0)
    for (const keyframe of tokens) {
      expect(GLOBALS, `@keyframes ${keyframe}`).toMatch(new RegExp(`@keyframes\\s+${keyframe}\\b`))
    }
  })

  it("animates the overlay keyframes on opacity and the independent transform properties only", () => {
    // A keyframe writing `transform` would overwrite the Tailwind translate that
    // centres a dialog and throw it into a corner mid-animation.
    for (const name of ["jinn-overlay-in", "jinn-overlay-out", "jinn-pop-in", "jinn-pop-out", "jinn-sheet-in", "jinn-sheet-out"]) {
      const body = keyframeBody(name)
      expect(body, name).not.toContain("transform:")
      for (const property of body.matchAll(/([a-z-]+):/g)) {
        expect(["opacity", "scale", "translate"], `${name} animates ${property[1]}`).toContain(property[1])
      }
    }
  })

  it("routes the view transition and the nav chrome through the tokens", () => {
    expect(GLOBALS).toMatch(/::view-transition-new\(root\)[\s\S]*?animation-duration: var\(--duration-base\)/)
    expect(GLOBALS).toContain("::view-transition-new(jinn-nav-rail)")
    expect(GLOBALS).toContain("::view-transition-new(jinn-tab-bar)")
    expect(source("components/pill-nav.tsx")).toContain("[view-transition-name:jinn-nav-rail]")
    expect(source("components/chat/mobile-tab-bar.tsx")).toContain("[view-transition-name:jinn-tab-bar]")
  })

  it("asks React Router for a view transition on every nav link", () => {
    for (const file of ["components/pill-nav.tsx", "components/chat/mobile-tab-bar.tsx"]) {
      const text = source(file)
      const links = text.match(/<Link\b/g) ?? []
      expect(links.length, `${file} <Link>s`).toBeGreaterThan(0)
      expect((text.match(/\bviewTransition\b/g) ?? []).length, file).toBe(links.length)
    }
  })
})

describe("touched files", () => {
  it.each(TOUCHED)("%s carries no class from the uninstalled animation plugin", (file) => {
    const text = source(file)
    for (const dead of PLUGIN_CLASSES) {
      expect(text, `${file} still uses ${dead}`).not.toContain(dead)
    }
  })

  it.each(TOUCHED)("%s spells no duration or curve of its own", (file) => {
    const text = source(file)
    expect(text).not.toMatch(/\d+ms\b/)
    expect(text).not.toContain("cubic-bezier(")
  })

  it.each(OVERLAYS)("%s animates on the way out as well as in", (file) => {
    const theme = themeBlock()
    const entering = animationsFor(file, "open")
    const leaving = animationsFor(file, "closed")
    expect(entering.length, `${file} enter animations`).toBeGreaterThan(0)
    expect(leaving).toHaveLength(entering.length)
    for (const name of [...entering, ...leaving]) {
      expect(theme, `--animate-${name}`).toContain(`--animate-${name}:`)
    }
  })
})
