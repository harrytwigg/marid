import { afterEach, describe, expect, it } from "vitest"
import { Puzzle, lookupIcon } from "@/components/ui/icon"
import { contributions } from "@/contrib/registry"
import { AREAS } from "@/contrib/types"
import { navigationFor } from "../nav"

/** The `sidebar.nav` host. A contributed row reaches every consumer of
 *  `navigationFor`, with a glyph it named out of the SDK's icon set, with one it
 *  passed as a component, or with the fallback. */

const disposers: (() => void)[] = []

function contribute(id: string, data: unknown): void {
  disposers.push(contributions.register({ id, area: AREAS.sidebarNav, data }, `plugin:${id}`))
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

describe("navigationFor", () => {
  it("includes a contributed row, after the app's own destinations", () => {
    contribute("inbox-demo:nav", { href: "/inbox-demo", label: "Inbox Demo" })

    const { items } = navigationFor(false)

    expect(items.at(-1)).toMatchObject({ href: "/inbox-demo", label: "Inbox Demo" })
    expect(items.map((item) => item.href)).toContain("/settings")
  })

  it("gives a row with no icon the fallback glyph rather than dropping it", () => {
    contribute("inbox-demo:nav", { href: "/inbox-demo", label: "Inbox Demo" })

    expect(navigationFor(false).items.at(-1)?.icon).toBe(Puzzle)
  })

  it("keeps a contributed icon when one is supplied", () => {
    contribute("bundled:nav", { href: "/bundled", label: "Bundled", icon: Puzzle })

    expect(navigationFor(false).items.at(-1)?.icon).toBe(Puzzle)
  })

  /* A name is how a disk plugin supplies a glyph: it cannot import a component,
   * so a string out of the SDK's set is the whole mechanism. */
  it("resolves an icon named out of the SDK's set", () => {
    contribute("inbox-demo:nav", { href: "/inbox-demo", label: "Inbox Demo", icon: "inbox" })

    expect(navigationFor(false).items.at(-1)?.icon).toBe(lookupIcon("inbox"))
    expect(navigationFor(false).items.at(-1)?.icon).not.toBe(Puzzle)
  })

  it("falls back rather than blanking the row when the name is not in the set", () => {
    contribute("typo:nav", { href: "/typo", label: "Typo", icon: "inbocks" })

    expect(navigationFor(false).items.at(-1)?.icon).toBe(Puzzle)
  })

  it("carries contributed rows into the mobile overflow, not into the primary tabs", () => {
    contribute("inbox-demo:nav", { href: "/inbox-demo", label: "Inbox Demo" })

    const { mobileItems, overflowHrefs } = navigationFor(false)

    expect(mobileItems.map((item) => item.href)).not.toContain("/inbox-demo")
    expect(overflowHrefs).toContain("/inbox-demo")
  })

  it("ignores a row that names no usable destination", () => {
    contribute("no-href", { label: "Nowhere" })
    contribute("relative-href", { href: "inbox", label: "Relative" })
    contribute("no-label", { href: "/inbox" })

    expect(navigationFor(false).items.map((item) => item.href)).not.toContain("/inbox")
    expect(navigationFor(false).items.map((item) => item.label)).not.toContain("Nowhere")
  })

  it("drops the row again when the plugin unloads", () => {
    contribute("inbox-demo:nav", { href: "/inbox-demo", label: "Inbox Demo" })
    for (const dispose of disposers.splice(0)) dispose()

    expect(navigationFor(false).items.map((item) => item.href)).not.toContain("/inbox-demo")
  })
})
