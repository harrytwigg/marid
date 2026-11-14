import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { installPluginSdk, sdkImportMap, shimSource } from '../runtime'

describe('shim source', () => {
  it('derives its export names from the namespace it is given', () => {
    const source = shimSource('__TEST_NS__', { alpha: 1, beta: 2 })

    expect(source).toContain('export const { alpha, beta } = m;')
    expect(source).toContain('const m = globalThis.__TEST_NS__;')
  })

  // The whole point of deriving names: an export added to the SDK barrel has to
  // reach a disk plugin without anyone remembering to edit the generator.
  it('picks up a name added to the namespace with no edit here', () => {
    expect(shimSource('__TEST_NS__', { alpha: 1, freshlyAdded: 2 })).toContain('freshlyAdded')
  })

  it('re-exports the default separately rather than as a destructured name', () => {
    const source = shimSource('__TEST_NS__', { default: 1, alpha: 2 })

    expect(source).toContain('export default m.default ?? m;')
    expect(source).toContain('export const { alpha } = m;')
  })

  // `export const { } = m` is a syntax error, so a namespace with nothing to
  // destructure has to emit no destructuring at all.
  it('emits no destructuring for a namespace with no usable names', () => {
    const source = shimSource('__TEST_NS__', {})

    expect(source).not.toContain('export const')
    expect(() => new Function(source.replace(/^export .*$/gm, ''))).not.toThrow()
  })

  it('skips names that are not valid bindings', () => {
    expect(shimSource('__TEST_NS__', { 'not-an-identifier': 1, ok: 2 })).toContain(
      'export const { ok } = m;',
    )
  })
})

describe('sdkImportMap before installPluginSdk', () => {
  // The barrel is resolved by the install rather than bound statically, so the
  // window where there is nothing to derive shims from is real. It says which
  // call is missing rather than emitting shims over an undefined namespace.
  it('refuses to build shims and names the call that was skipped', () => {
    expect(() => sdkImportMap()).toThrow(/installPluginSdk/)
  })
})

describe('installPluginSdk', () => {
  it('names the @hundredfold/plugin-sdk alias dynamically so a broken mapping fails this build', () => {
    const source = readFileSync('src/plugins/sdk/runtime.ts', 'utf8')
    expect(source).toMatch(/import\(['"]@hundredfold\/plugin-sdk['"]\)/)
    expect(source).not.toMatch(/\bimport\s+['"]@hundredfold\/plugin-sdk['"]/)
  })

  it('puts the app’s own SDK and React on the globals the shims read', async () => {
    await installPluginSdk()

    const globals = globalThis as Record<string, unknown>
    const sdk = await import('../index')
    const react = await import('react')

    expect(globals.__HUNDREDFOLD_PLUGIN_SDK__).toBe(sdk)
    expect(globals.__HUNDREDFOLD_REACT__).toBe(react)
    expect(globals.__HUNDREDFOLD_REACT_JSX__).toBe(await import('react/jsx-runtime'))
  })
})

describe('sdkImportMap', () => {
  beforeAll(async () => {
    await installPluginSdk()
  })

  it('maps exactly the supported specifiers: the SDK under its current and its old name, react and its JSX runtime', () => {
    expect(Object.keys(sdkImportMap()).sort()).toEqual([
      '@hundredfold/plugin-sdk',
      '@hundredfold/plugin-sdk', // rename:keep: plugins installed before the rename import the SDK by its old name
      'react',
      'react/jsx-runtime',
    ])
  })

  // Every rewritten plugin points at these URLs for as long as the tab lives, so
  // a second call handing out fresh ones would strand the first plugin's imports.
  it('hands out the same URLs on every call', () => {
    expect(sdkImportMap()).toEqual(sdkImportMap())
  })

  /* Deriving the names is only half of it: what a plugin writes in an import
   * statement has to appear in the destructuring, or the import throws at
   * evaluation. These are what 1.2.0 added. */
  it('destructures the primitives the barrel exports', async () => {
    const sdk = await import('../index')

    const names = /export const \{ (.+) \} = m;/
      .exec(shimSource('__HUNDREDFOLD_PLUGIN_SDK__', sdk))?.[1]
      ?.split(', ')

    expect(names).toEqual(
      expect.arrayContaining([
        'Icon',
        'Input',
        'Badge',
        'Tooltip',
        'TooltipTrigger',
        'TooltipContent',
        'DropdownMenu',
        'DropdownMenuTrigger',
        'DropdownMenuContent',
        'DropdownMenuItem',
        'ScrollArea',
      ]),
    )
  })
})
