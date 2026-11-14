/**
 * The no-build ESM door (`.plans/plugins.md` §4). One `client.js` takes this
 * pipeline:
 *
 *   source -> reject unsupported bare specifiers -> rewrite the mapped ones to
 *   live shim blobs -> blob `import()` -> validate the default export ->
 *   `register(ctx)`
 *
 * Registration is unconditional: the gateway only serves the client half of a
 * plugin the operator enabled in `config.yaml`, so being handed a source here
 * IS the decision. The dashboard keeps no enablement state of its own.
 *
 * Loading an id that is already live disposes the previous incarnation first,
 * so a saved edit is a clean reload rather than a second registration beside
 * the first.
 *
 * SECURITY, and §9 is blunt about it: this is error isolation, not a capability
 * boundary. A loaded plugin is evaluated as ESM in the dashboard's own realm
 * with the app's full authority. It cannot crash the app; it can do anything the
 * app can. That is acceptable for a local directory the operator controls, and
 * it is exactly why a remote source may not reuse this pipeline as it stands.
 */
import { installPluginSdk, sdkImportMap } from './sdk/runtime'
import { createPluginContext, type HundredfoldPlugin } from './plugin-context'

/** Every failure this loader raises, named so a caller can tell a rejected
 *  plugin from a bug in the loader itself. */
export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginLoadError'
  }
}

/** Live plugins: id -> the disposers of its current incarnation. */
const loaded = new Map<string, (() => void)[]>()

/**
 * Matches the specifier of a static `from '…'`, a side-effect `import '…'`, or
 * a dynamic `import('…')`. Byte-identical to hermes
 * `apps/desktop/src/contrib/runtime-loader.ts:51`, and exported so a test can
 * pin it there: the anchor is the whole safety property, and widening it is how
 * a rewrite starts reaching text that is not an import.
 *
 * What the anchor buys, stated exactly: no string literal is touched, because a
 * literal is only ever rewritten when `import` or `from` immediately precedes
 * it — `notify('react')` and `const label = 'react'` both come through
 * unchanged. What the anchor cannot tell apart is code from a comment quoting
 * the same syntax, so every scan below runs over `codeOnly()` rather than over
 * the raw source.
 */
export const importSpecifierRe = () => /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g

const QUOTES = new Set(['"', "'", '`'])

/** Index just past the literal opening at `start`. */
function literalEnd(source: string, start: number): number {
  const quote = source[start]
  let cursor = start + 1

  while (cursor < source.length && source[cursor] !== quote) {
    cursor += source[cursor] === '\\' ? 2 : 1
  }

  return cursor + 1
}

/** Index just past the comment opening at `start`, or -1 if none opens there. */
function commentEnd(source: string, start: number): number {
  if (source[start] !== '/') return -1

  if (source[start + 1] === '/') {
    const newline = source.indexOf('\n', start + 2)
    return newline === -1 ? source.length : newline
  }

  if (source[start + 1] === '*') {
    const close = source.indexOf('*/', start + 2)
    return close === -1 ? source.length : close + 2
  }

  return -1
}

/**
 * The source with comment bodies blanked to spaces. Offsets are preserved, so a
 * match found here indexes straight back into the original — which is what lets
 * a scan skip comments while the rewrite still edits the real text. String and
 * template state is tracked only so that a `//` inside a literal (a URL, most
 * often) is not read as the start of a comment.
 */
function codeOnly(source: string): string {
  const masked = source.split('')
  let cursor = 0

  while (cursor < source.length) {
    const comment = commentEnd(source, cursor)

    if (comment !== -1) {
      while (cursor < comment) masked[cursor++] = ' '
    } else if (QUOTES.has(source[cursor])) {
      cursor = literalEnd(source, cursor)
    } else {
      cursor += 1
    }
  }

  return masked.join('')
}

/** The shim URL for a specifier, or undefined. `Object.hasOwn` rather than
 *  truthiness: the map is an ordinary object, so `map['constructor']` answers
 *  with a function off the prototype and would let `import 'constructor'`
 *  through the allowlist. */
function shimUrl(map: Record<string, string>, specifier: string): string | undefined {
  return Object.hasOwn(map, specifier) ? map[specifier] : undefined
}

/** Rewrite ONLY mapped import specifiers to their live shim blob URLs. */
function rewriteSpecifiers(source: string): string {
  const map = sdkImportMap()
  let rewritten = ''
  let cursor = 0

  for (const match of codeOnly(source).matchAll(importSpecifierRe())) {
    const [whole, pre, quote, specifier] = match
    const url = shimUrl(map, specifier)
    if (url === undefined) continue

    rewritten += source.slice(cursor, match.index) + `${pre}${quote}${url}${quote}`
    cursor = match.index + whole.length
  }

  return rewritten + source.slice(cursor)
}

/** Bare specifiers this loader cannot resolve — not relative, not a URL, and
 *  not in the SDK map. Surfaced up front so they do not arrive as a cryptic
 *  native "Failed to resolve module specifier" from the blob import. */
function unsupportedImports(source: string): string[] {
  const map = sdkImportMap()
  const bare = new Set<string>()

  for (const match of codeOnly(source).matchAll(importSpecifierRe())) {
    const specifier = match[3]
    if (!specifier || shimUrl(map, specifier) !== undefined) continue
    // Relative and absolute paths and any URL scheme are the browser's to
    // resolve against the blob, not ours to reject.
    if (/^[./]/.test(specifier) || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) continue
    bare.add(specifier)
  }

  return [...bare]
}

/** Evaluate the rewritten source as a module. The URL is revoked either way —
 *  an import that threw has still consumed it. */
async function evaluate(source: string): Promise<unknown> {
  const url = URL.createObjectURL(
    new Blob([rewriteSpecifiers(source)], { type: 'text/javascript' }),
  )

  try {
    return await import(/* @vite-ignore */ url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The default export, checked field by field. Everything downstream treats the
 *  result as a plugin, so this is the only place its shape is in doubt. */
function validate(module: unknown, origin: string): HundredfoldPlugin {
  const reject = (problem: string) => new PluginLoadError(`${origin}: ${problem}`)
  const exported: unknown = (module as { default?: unknown }).default

  if (typeof exported !== 'object' || exported === null) {
    throw reject('client.js must default-export a plugin object { id, name?, register(ctx) }')
  }

  const { id, name, register } = exported as Record<string, unknown>
  if (typeof id !== 'string' || id === '') throw reject('a plugin needs a non-empty string id')
  if (typeof register !== 'function') {
    throw reject(`register must be a function, not ${typeof register}`)
  }
  if (name !== undefined && typeof name !== 'string') {
    throw reject(`name must be a string when present, not ${typeof name}`)
  }

  // The three checks above are what make this cast true; `register` needs it
  // because `typeof x === 'function'` narrows to `Function`, which is not callable
  // with the context type.
  return { id, name, register: register as HundredfoldPlugin['register'] }
}

/** Register the plugin, disposing whatever it is replacing. */
function activate(plugin: HundredfoldPlugin): void {
  // A reload disposes the previous incarnation before the new one registers.
  // Registering first would leave the old disposers holding entries that the
  // new registration has already replaced.
  unloadRuntimePlugin(plugin.id)
  const disposers: (() => void)[] = []
  loaded.set(plugin.id, disposers)

  try {
    plugin.register(createPluginContext(plugin.id, (dispose) => disposers.push(dispose)))
  } catch (error) {
    // Whatever it managed to register before it threw is already tracked above,
    // so the half-built incarnation still comes down on the next unload.
    console.error(`[plugins] ${plugin.id} threw while registering`, error)
  }
}

/** Dispose one plugin's current incarnation. */
export function unloadRuntimePlugin(id: string): void {
  for (const dispose of loaded.get(id) ?? []) {
    try {
      dispose()
    } catch (error) {
      // One cleanup throwing must not strand the rest of the same plugin's
      // disposers, or a reload leaves half the previous incarnation live.
      console.error(`[plugins] ${id} threw while disposing`, error)
    }
  }
  loaded.delete(id)
}

/**
 * Evaluate and register one plugin. Returns the id it loaded under — which is
 * the plugin's own, not necessarily `origin` — or null if it was rejected.
 *
 * `origin` is the directory the source came from. It names the failure, so a
 * plugin too broken to have an id is still something a reader can place.
 */
export async function loadRuntimePlugin(source: string, origin: string): Promise<string | null> {
  try {
    // Inside the try because it now fetches the SDK barrel's chunk: a deploy
    // that superseded it should be reported against this plugin, not surface as
    // an unhandled rejection in the reconcile pass above.
    await installPluginSdk()

    const unsupported = unsupportedImports(source)
    if (unsupported.length > 0) {
      throw new PluginLoadError(
        `${origin} imports ${unsupported.join(', ')}, which this loader cannot resolve. ` +
          `A plugin may import only ${Object.keys(sdkImportMap()).join(', ')}.`,
      )
    }

    const plugin = validate(await evaluate(source), origin)
    activate(plugin)
    return plugin.id
  } catch (error) {
    console.error(`[plugins] ${origin} failed to load`, error)
    return null
  }
}
