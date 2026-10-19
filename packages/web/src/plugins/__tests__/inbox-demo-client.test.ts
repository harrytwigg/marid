import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Puzzle } from '@/components/ui/icon'
import { contributions } from '@/contrib/registry'
import { AREAS } from '@/contrib/types'
import { navigationFor } from '@/lib/nav'
import { loadRuntimePlugin, unloadRuntimePlugin } from '../runtime-loader'
import { useDataUrlModules } from './data-url-modules'

/**
 * The reference plugin's client half, taken through the shipped loader.
 *
 * The source is the file in `examples/plugins/inbox-demo/`, not a fixture, so
 * this is what pins the demo to the loader's import allowlist: the day it grows
 * an import the allowlist does not cover, the loader rejects it and this fails
 * rather than a reader discovering it.
 */

const DEMO_CLIENT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../examples/plugins/inbox-demo/client.js',
)

const source = readFileSync(DEMO_CLIENT, 'utf-8')

function contributionIn(area: string): { id: string; source: string } | undefined {
  return contributions.getArea(area).find((entry) => entry.source === 'plugin:inbox-demo')
}

beforeAll(() => {
  useDataUrlModules()
})

beforeEach(() => {
  unloadRuntimePlugin('inbox-demo')
})

describe('examples/plugins/inbox-demo/client.js', () => {
  it('loads through the runtime loader under its own id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await loadRuntimePlugin(source, 'inbox-demo')).toBe('inbox-demo')

    expect(error).not.toHaveBeenCalled()
    expect(contributionIn(AREAS.routes)).toBeDefined()
    error.mockRestore()
  })

  it('lands a contribution in all three v1 areas', async () => {
    await loadRuntimePlugin(source, 'inbox-demo')

    for (const area of [AREAS.routes, AREAS.sidebarNav, AREAS.statusbarRight]) {
      expect(contributionIn(area), `nothing contributed to ${area}`).toBeDefined()
    }
  })

  it('claims a route path and a nav destination that agree with each other', async () => {
    await loadRuntimePlugin(source, 'inbox-demo')

    const page = contributions.getArea(AREAS.routes).find((entry) => entry.source === 'plugin:inbox-demo')
    const nav = contributions.getArea(AREAS.sidebarNav).find((entry) => entry.source === 'plugin:inbox-demo')

    expect((page?.data as { path?: string }).path).toBe('/inbox-demo')
    expect((nav?.data as { href?: string }).href).toBe('/inbox-demo')
  })

  /* The demo is what an author copies, so its nav row has to arrive with a glyph
   * of its own rather than the fallback every iconless row shares. */
  it('resolves its nav row to a real icon rather than the fallback glyph', async () => {
    await loadRuntimePlugin(source, 'inbox-demo')

    const row = navigationFor(false).items.find((item) => item.href === '/inbox-demo')

    expect(row?.icon).toBeDefined()
    expect(row?.icon).not.toBe(Puzzle)
  })

  it('namespaces its local contribution ids under the plugin', async () => {
    await loadRuntimePlugin(source, 'inbox-demo')

    expect(contributionIn(AREAS.routes)?.id).toBe('inbox-demo:page')
  })

  it('takes every contribution down again on unload', async () => {
    await loadRuntimePlugin(source, 'inbox-demo')
    unloadRuntimePlugin('inbox-demo')

    for (const area of [AREAS.routes, AREAS.sidebarNav, AREAS.statusbarRight]) {
      expect(contributionIn(area)).toBeUndefined()
    }
  })
})
