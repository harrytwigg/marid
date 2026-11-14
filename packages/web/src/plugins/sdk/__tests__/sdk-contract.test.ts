import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as sdk from '@hundredfold/plugin-sdk'
import { ICONS } from '@/components/ui/icon'
import { SDK_CONTRACT_VERSION } from '../version'

const SDK_DIR = path.resolve(__dirname, '..')
/* The contract is three files — `sdk.d.ts` re-exports the UI and host halves — and
 * the checks below are about the contract, not about a file. Reading only the
 * entry point would let a name move into `sdk-ui.d.ts` and out of the sync
 * check on the same edit. */
const CONTRACT = ['sdk.d.ts', 'sdk-ui.d.ts', 'sdk-host.d.ts']
  .map((file) => readFileSync(path.join(SDK_DIR, file), 'utf8'))
  .join('\n')
const BARREL = readFileSync(path.join(SDK_DIR, 'index.ts'), 'utf8')

/** The names the contract declares as values, which is what a runtime export is. */
function declaredValues(contract: string): string[] {
  return [...contract.matchAll(/^export declare (?:const|function|class) (\w+)/gm)].map(
    (match) => match[1]!,
  )
}

/** The names the contract declares as types, which nothing exports at runtime. */
function declaredTypes(contract: string): string[] {
  return [...contract.matchAll(/^export (?:type|interface) (\w+)/gm)].map((match) => match[1]!)
}

/** The names the barrel re-exports through `export type { … }`. */
function barrelTypeExports(barrel: string): string[] {
  return [...barrel.matchAll(/export type \{([\s\S]*?)\}/g)].flatMap((match) =>
    match[1]!
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  )
}

/** Every module specifier the contract names, in either quote style. */
function importedSpecifiers(contract: string): string[] {
  return [...contract.matchAll(/from (['"])([^'"]+)\1|import\((['"])([^'"]+)\3\)/g)].map(
    (match) => (match[2] ?? match[4])!,
  )
}

/** Whether a relative specifier lands outside the sdk directory. Resolving it
 *  rather than reading its first characters is the point: `./../../lib/x` walks
 *  out just as surely as `../../lib/x` does. */
function escapesSdkDirectory(specifier: string): boolean {
  if (!specifier.startsWith('.')) return false

  const resolved = path.resolve(SDK_DIR, specifier)
  return resolved !== SDK_DIR && !resolved.startsWith(SDK_DIR + path.sep)
}

describe('the SDK re-exports the app’s own instances', () => {
  it('exports the React the app itself resolved', async () => {
    const react = await import('react')

    expect(sdk.React).toBe(react.default)
  })

  it('exports the jsx runtime the app itself resolved', async () => {
    const runtime = await import('react/jsx-runtime')

    expect(sdk.jsx).toBe(runtime.jsx)
    expect(sdk.jsxs).toBe(runtime.jsxs)
  })

  it('exports the app’s single query client', async () => {
    const { queryClient } = await import('@/lib/query-client')

    expect(sdk.queryClient).toBe(queryClient)
  })
})

describe('the contribution areas', () => {
  /* The ids are the wire format: a plugin on disk names them in its manifest,
   * and nothing derives them, so renaming one has to fail here rather than at
   * a stranger's install. */
  it('exports the seven v1 area ids', () => {
    expect(new Set(Object.values(sdk.AREAS))).toEqual(
      new Set([
        'routes',
        'sidebar.nav',
        'statusbar.right',
        'todo.detail.actions',
        'todo.detail.sections',
        'chat.composer',
        'home.widgets',
      ]),
    )
  })
})

describe('the hand-authored contract cannot drift from the barrel', () => {
  it('declares exactly the runtime exports of index.ts, and no others', () => {
    expect(declaredValues(CONTRACT).sort()).toEqual(Object.keys(sdk).sort())
  })

  it('declares exactly the types index.ts exports, and no others', () => {
    expect(declaredTypes(CONTRACT).sort()).toEqual(barrelTypeExports(BARREL).sort())
  })

  it('names no module a plugin author could not resolve', () => {
    for (const specifier of importedSpecifiers(CONTRACT)) {
      expect(specifier.startsWith('@/'), `${specifier} is an app-internal path`).toBe(false)
      expect(escapesSdkDirectory(specifier), `${specifier} escapes the sdk directory`).toBe(false)
    }
  })

  /* The firewall above is only worth as much as the two helpers underneath it,
   * and both had a hole a plausible edit walks straight through: a double quote,
   * and a relative path that leaves the directory without opening on `..`. */
  it('catches the app-internal forms a prefix check misses', () => {
    const evasions = ['import type { X } from "@/lib/x"', "import type { Y } from './../../lib/y'"]

    expect(importedSpecifiers(evasions.join('\n'))).toEqual(['@/lib/x', './../../lib/y'])
    expect(escapesSdkDirectory('./../../lib/y')).toBe(true)
    expect(escapesSdkDirectory('./host-state')).toBe(false)
  })

  it('carries the version the SDK itself exports', () => {
    const declared = /export declare const SDK_CONTRACT_VERSION: '([^']+)'/.exec(CONTRACT)?.[1]

    expect(declared).toBe(SDK_CONTRACT_VERSION)
  })

  /* `IconName` is a hand-written union over a map the contract cannot see, so
   * the two drift the moment an icon is added. A plugin typechecks against the
   * union and renders against the map; a name in one and not the other is a
   * missing glyph in the app or a rejected build in the plugin. */
  it('declares an icon name for every icon the set carries, and no others', () => {
    const union = /export type IconName =\s*([\s\S]*?)\n\n/.exec(CONTRACT)?.[1] ?? ''
    const declared = [...union.matchAll(/'([^']+)'/g)].map((match) => match[1]!)

    expect(declared.sort()).toEqual(Object.keys(ICONS).sort())
  })
})

/* 1.2.0 is additive, and the only thing that makes that true rather than
 * intended is a list of what 1.1.0 shipped. A plugin written against 1.1.0
 * imports these names; losing or renaming one breaks it at load, which is the
 * one failure a version bump is supposed to rule out. */
describe('the v1.1.0 surface survives every later version', () => {
  const V1_1_0_EXPORTS = [
    'AREAS',
    'Button',
    'Card',
    'CardContent',
    'CardDescription',
    'CardFooter',
    'CardHeader',
    'CardTitle',
    'Dialog',
    'DialogClose',
    'DialogContent',
    'DialogDescription',
    'DialogFooter',
    'DialogHeader',
    'DialogTitle',
    'DialogTrigger',
    'Fragment',
    'PluginHostDeniedError',
    'PluginSdkError',
    'React',
    'SDK_CONTRACT_VERSION',
    'Select',
    'SelectContent',
    'SelectItem',
    'SelectTrigger',
    'SelectValue',
    'Skeleton',
    'Switch',
    'Tabs',
    'TabsContent',
    'TabsList',
    'TabsTrigger',
    'Textarea',
    'cn',
    'host',
    'jsx',
    'jsxs',
    'queryClient',
  ]

  it('still exports every name it did', () => {
    expect(Object.keys(sdk)).toEqual(expect.arrayContaining(V1_1_0_EXPORTS))
  })
})
