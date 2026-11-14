import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginLoadError, importSpecifierRe, loadRuntimePlugin } from '../runtime-loader'
import { useDataUrlModules, type ModuleUrls } from './data-url-modules'

let urls: ModuleUrls
let consoleError: ReturnType<typeof vi.spyOn>

beforeAll(() => {
  urls = useDataUrlModules()
})

beforeEach(() => {
  urls.created.length = 0
  urls.revoked.length = 0
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

/** Ids must stay fresh: the module cache would answer a repeat load from the
 *  first evaluation, and the contributions registry outlives one test. */
let idCounter = 0
const freshId = () => `probe-${(idCounter += 1)}`

/** The error the loader logged alongside its message. */
const loggedError = () => consoleError.mock.calls.at(-1)?.[1]
const loggedMessage = () => (loggedError() as Error | undefined)?.message ?? ''

describe('unsupported specifiers', () => {
  it('rejects a bare specifier the SDK map does not cover, before evaluating', async () => {
    const id = freshId()
    const source =
      `import lodash from 'lodash';\n` +
      `globalThis.${id.replace('-', '_')} = 'evaluated';\n` +
      `export default { id: ${JSON.stringify(id)}, register() {} };\n`

    expect(await loadRuntimePlugin(source, id)).toBeNull()

    // Nothing was evaluated: the module body's side effect never happened, the
    // plugin's own source was never handed to the object-URL factory, and the
    // revoke that only `evaluate` performs never ran either. (The SDK shims are
    // built to answer "is this specifier supported", so they are created; the
    // plugin is not.)
    expect((globalThis as Record<string, unknown>)[id.replace('-', '_')]).toBeUndefined()
    expect(urls.created.some((created) => created.includes(id))).toBe(false)
    expect(urls.revoked).toEqual([])
    expect(loggedError()).toBeInstanceOf(PluginLoadError)
    expect(loggedMessage()).toContain('lodash')
  })

  it('lists every offending specifier, once each', async () => {
    const id = freshId()
    const source =
      `import a from 'lodash';\nimport b from 'zod';\nimport c from 'lodash';\n` +
      `export default { id: ${JSON.stringify(id)}, register() {} };\n`

    await loadRuntimePlugin(source, id)

    expect(loggedMessage()).toContain('lodash, zod')
  })

  it('rejects a name the SDK map only inherits from Object.prototype', async () => {
    const id = freshId()
    const probe = id.replace('-', '_')
    const source =
      `import 'constructor';\n` +
      `globalThis.${probe} = 'evaluated';\n` +
      `export default { id: ${JSON.stringify(id)}, register() {} };\n`

    expect(await loadRuntimePlugin(source, id)).toBeNull()

    // Membership, not truthiness: `map['constructor']` answers with a function
    // off the prototype, which would wave the import past the allowlist and let
    // the module body run.
    expect((globalThis as Record<string, unknown>)[probe]).toBeUndefined()
    expect(loggedError()).toBeInstanceOf(PluginLoadError)
    expect(loggedMessage()).toContain('constructor')
  })

  it('does not reject an import that only appears inside a comment', async () => {
    const id = freshId()
    const source =
      `// import lodash from 'lodash';\n` +
      `/* import zod from 'zod'; */\n` +
      `export default { id: ${JSON.stringify(id)}, register() {} };\n`

    expect(await loadRuntimePlugin(source, id)).toBe(id)
  })

  // The direction of the comment mask that would be a hole rather than a
  // cosmetic slip: a regex literal carrying a quote leaves the mask mid-string,
  // and a real import masked away is one that gets let through.
  it('still rejects an import that follows a regex literal containing a quote', async () => {
    const id = freshId()
    const source =
      `const re = /['"]/g;\n` +
      `import x from 'lodash';\n` +
      `export default { id: ${JSON.stringify(id)}, name: re.source + x, register() {} };\n`

    expect(await loadRuntimePlugin(source, id)).toBeNull()
    expect(loggedMessage()).toContain('lodash')
  })

  it.each([
    ['@hundredfold/plugin-sdk', `import { AREAS } from '@hundredfold/plugin-sdk';`],
    ['react', `import React from 'react';`],
    ['react/jsx-runtime', `import { jsx } from 'react/jsx-runtime';`],
    ['a relative path', `import './helper.js';`],
    ['a URL', `import 'https://example.test/m.js';`],
  ])('does not reject %s', async (_label, statement) => {
    const id = freshId()

    await loadRuntimePlugin(
      `${statement}\nexport default { id: ${JSON.stringify(id)}, register() {} };\n`,
      id,
    )

    // Reaching the object-URL factory is the proof the allowlist let it past: a
    // rejected specifier never evaluates, so its source is never handed over.
    // (Relative and URL specifiers still fail downstream here — nothing native
    // can resolve them against a data: URL — which is the browser's business,
    // not this loader's.)
    expect(urls.created.some((created) => created.includes(id))).toBe(true)
  })
})

describe('specifier rewriting', () => {
  // Pinned to hermes `apps/desktop/src/contrib/runtime-loader.ts:51`. The anchor
  // is the whole safety property: widen it and a matching string literal starts
  // getting rewritten.
  it('uses the regex hermes uses, byte for byte', () => {
    expect(importSpecifierRe().source).toBe(
      String.raw`(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2`,
    )
    expect(importSpecifierRe().flags).toBe('g')
  })

  it('rewrites real specifiers and leaves string literals alone', async () => {
    const id = freshId()
    const source =
      `import { host } from '@hundredfold/plugin-sdk';\n` +
      `const label = 'react';\n` +
      `host.notify('react');\n` +
      `export default { id: ${JSON.stringify(id)}, name: label, register() {} };\n`

    await loadRuntimePlugin(source, id)

    const rewritten = urls.created.at(-1) ?? ''
    expect(rewritten).toContain(`import { host } from 'data:text/javascript,`)
    expect(rewritten).not.toContain(`from '@hundredfold/plugin-sdk'`)
    // The two forms a plugin can spell `react` in without meaning an import.
    expect(rewritten).toContain(`const label = 'react';`)
    expect(rewritten).toContain(`host.notify('react');`)
  })

  it('leaves a comment that quotes import syntax exactly as written', async () => {
    const id = freshId()
    const source =
      `// docs from 'react'\n` +
      `/* see import { jsx } from 'react/jsx-runtime' */\n` +
      `import { host } from '@hundredfold/plugin-sdk';\n` +
      `export default { id: ${JSON.stringify(id)}, name: host ? 'a' : 'b', register() {} };\n`

    await loadRuntimePlugin(source, id)

    const rewritten = urls.created.at(-1) ?? ''
    expect(rewritten).toContain(`// docs from 'react'`)
    expect(rewritten).toContain(`/* see import { jsx } from 'react/jsx-runtime' */`)
    // The real import beyond the comments is still rewritten.
    expect(rewritten).toContain(`import { host } from 'data:text/javascript,`)
  })

  it('revokes the module URL once the import has settled', async () => {
    const id = freshId()

    await loadRuntimePlugin(`export default { id: ${JSON.stringify(id)}, register() {} };\n`, id)

    expect(urls.revoked).toHaveLength(1)
  })
})

describe('default export validation', () => {
  it.each([
    ['no default export', 'export const nope = 1;', 'default-export a plugin object'],
    ['a default that is not an object', 'export default 42;', 'default-export a plugin object'],
    ['no id', 'export default { register() {} };', 'non-empty string id'],
    ['an empty id', 'export default { id: "", register() {} };', 'non-empty string id'],
    ['a non-function register', 'export default { id: "x", register: 3 };', 'register must be a function'],
    ['a non-string name', 'export default { id: "x", name: 7, register() {} };', 'name must be a string'],
  ])('rejects %s with a logged error and no throw', async (_label, body, expected) => {
    const id = freshId()

    // A comment carrying the id keeps every case a distinct module: identical
    // sources become one data: URL, and the module cache would answer the second
    // load from the first evaluation.
    await expect(loadRuntimePlugin(`// ${id}\n${body}\n`, id)).resolves.toBeNull()

    expect(loggedError()).toBeInstanceOf(PluginLoadError)
    expect(loggedMessage()).toContain(expected)
  })

  it('names the folder it came from in the log, not the id it claimed', async () => {
    const origin = freshId()

    await loadRuntimePlugin(`// ${origin}\nexport default { id: "claimed" };\n`, origin)

    expect(consoleError.mock.calls.at(-1)?.[0]).toContain(origin)
    expect(loggedMessage()).not.toContain('claimed')
  })
})
