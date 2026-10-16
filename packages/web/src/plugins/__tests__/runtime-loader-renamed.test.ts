import { beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

// A build whose codename says "acme": its own package name is `@acme/plugin-sdk`, and the plugins already
// installed on disk were written against `@jinn/plugin-sdk`.
vi.mock('@jinn/codename', () => ({ CODENAME: 'acme' }))

import * as sdk from '@/plugins/sdk'
import { contributions } from '@/contrib/registry'
import { loadRuntimePlugin, unloadRuntimePlugin } from '../runtime-loader'
import { useDataUrlModules } from './data-url-modules'

beforeAll(() => {
  useDataUrlModules()
})

let errorSpy: MockInstance<typeof console.error>
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

let counter = 0
function fresh(): { id: string; area: string } {
  counter += 1
  return { id: `renamed-${counter}`, area: `runtime.loader.renamed.${counter}` }
}

/** A plugin written the way a disk plugin is, importing nothing but the SDK, by `specifier`. */
function pluginImporting(specifier: string, id: string, area: string): string {
  return `import { SDK_CONTRACT_VERSION, React } from '${specifier}';
export default {
  id: ${JSON.stringify(id)},
  name: 'Probe',
  register(ctx) {
    ctx.contribute({ id: 'chip', area: ${JSON.stringify(area)}, data: { version: SDK_CONTRACT_VERSION, react: React } });
  },
};
`
}

describe('a disk plugin after the codename changes', () => {
  it.each(['@jinn/plugin-sdk', '@acme/plugin-sdk'])('still loads when it imports the SDK as %s, onto the app’s own SDK and React', async (specifier) => {
    const { id, area } = fresh()

    expect(await loadRuntimePlugin(pluginImporting(specifier, id, area), id)).toBe(id)

    const [entry] = contributions.getArea(area)
    const data = entry.data as { version: string; react: unknown }
    expect(data.version).toBe(sdk.SDK_CONTRACT_VERSION)
    expect(data.react).toBe(sdk.React)
    unloadRuntimePlugin(id)
  })

  it('still refuses a package that is neither spelling of the SDK', async () => {
    const { id, area } = fresh()

    expect(await loadRuntimePlugin(pluginImporting('@other/plugin-sdk', id, area), id)).toBeNull()
    expect(String((errorSpy.mock.calls.at(-1)?.[1] as Error | undefined)?.message)).toContain('@other/plugin-sdk')
  })
})
