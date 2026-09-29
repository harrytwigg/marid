import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const globals = source('../../globals.css')
const tabsCss = source('../mobile-session-tabs.css')

// The tabs stylesheet repeats the mobile value of --chat-header-band, because a
// custom property cannot read its own parent declaration. Nothing can execute
// that dependency, so the two sources are compared here.
describe('mobile session tabs header band', () => {
  it('adds the row height to the same base band globals.css declares below lg', () => {
    // The first declaration is the base below lg; the lg override comes later.
    const globalBase = globals.match(/--chat-header-band:\s*(\d+)px;/)?.[1]
    const tabsBase = tabsCss.match(/--chat-header-band:\s*calc\((\d+)px \+ var\(--mobile-session-tabs-height\)\)/)?.[1]
    expect(globalBase).toBeDefined()
    expect(tabsBase).toBe(globalBase)
  })
})
