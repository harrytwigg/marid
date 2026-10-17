/**
 * The runtime half of the two delivery modes in `.plans/plugins.md` §4.
 *
 * A bundled plugin resolves `@jinn/plugin-sdk` through the Vite alias. A disk
 * `client.js` writes the same specifier and has to land on the same object, so
 * the loader installs the live namespaces on globals and rewrites the specifier
 * to a shim module that reads them back off `globalThis`. React is the
 * mechanism rather than a convenience: a plugin that resolved a second React
 * would get a second dispatcher and every hook it called would throw.
 *
 * Export names are derived from the namespace instead of listed here, so adding
 * an export to the SDK barrel cannot leave the shim behind.
 */
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { pluginSdkSpecifiers } from '@/lib/codename'

/** The SDK's own specifiers: the current package name and the legacy one that plugins
 *  installed before a rename still write, both resolving to the one SDK. */
const SDK_SPECIFIERS = pluginSdkSpecifiers()

/** The specifiers a plugin may import, each with the global its shim
 *  reads. Membership is the allowlist the loader rejects against. */
const SDK_GLOBALS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(SDK_SPECIFIERS.map((specifier) => [specifier, '__JINN_PLUGIN_SDK__'])),
  react: '__JINN_REACT__',
  'react/jsx-runtime': '__JINN_REACT_JSX__',
}

type SdkSpecifier = string

/**
 * The namespaces behind those specifiers, resolved by the first install.
 *
 * The barrel is imported on demand rather than bound statically because it
 * re-exports every shared UI primitive — Select and Menu alone carry the whole
 * floating layer — and that put ~9 KB gzip of it on the first paint of a
 * dashboard whose plugins directory is usually empty. Nothing reads these
 * globals until a plugin is actually being loaded.
 */
let namespaces: Record<SdkSpecifier, object> | null = null

/** A name a shim can destructure. Anything else would be a syntax error in the
 *  generated module, and no import could have named it anyway. */
const BINDING_NAME = /^[A-Za-z_$][\w$]*$/

/** Install the app's own instances where the shims read them. Idempotent. */
export async function installPluginSdk(): Promise<void> {
  // The alias, not the relative path: a broken `@jinn/plugin-sdk` mapping
  // must fail this app build rather than a stranger's first plugin load.
  // Dynamic so the barrel (Select, Menu, the floating layer) stays off
  // the first paint of a dashboard whose plugins directory is empty.
  const sdk = namespaces ? null : await import('@jinn/plugin-sdk')
  namespaces ??= {
    ...Object.fromEntries(SDK_SPECIFIERS.map((specifier) => [specifier, sdk as object])),
    react: React,
    'react/jsx-runtime': jsxRuntime,
  }

  for (const [specifier, key] of Object.entries(SDK_GLOBALS)) {
    Object.assign(globalThis, { [key]: namespaces[specifier] })
  }
}

/**
 * A shim module that re-exports one global namespace's live members. Exported
 * so a test can hand it a namespace and read the names back, which is the only
 * way to prove the list is derived rather than written down.
 */
export function shimSource(globalKey: string, namespace: object): string {
  const names = Object.keys(namespace).filter(
    (name) => name !== 'default' && BINDING_NAME.test(name),
  )

  return (
    `const m = globalThis.${globalKey};\n` +
    `export default m.default ?? m;\n` +
    // `export const { } = m` is a syntax error, so a namespace with nothing to
    // destructure emits no destructuring at all.
    (names.length > 0 ? `export const { ${names.join(', ')} } = m;\n` : '')
  )
}

let cached: Record<string, string> | null = null

/**
 * Specifier to shim URL, for the loader's rewrite. Built once per tab and never
 * revoked: every rewritten plugin points at these URLs for as long as it is
 * loaded, so a second set would strand the first plugin's imports.
 */
export function sdkImportMap(): Record<string, string> {
  const resolved = namespaces
  if (!resolved) {
    throw new Error(
      'sdkImportMap: the SDK namespaces are not installed. Await installPluginSdk() first — ' +
        'the shims are generated from the namespaces it resolves.',
    )
  }

  // One shim per global: both spellings of the SDK specifier land on the same module.
  const byGlobal = new Map<string, string>()
  cached ??= Object.fromEntries(
    Object.entries(SDK_GLOBALS).map(([specifier, key]) => {
      if (!byGlobal.has(key)) {
        byGlobal.set(
          key,
          URL.createObjectURL(new Blob([shimSource(key, resolved[specifier])], { type: 'text/javascript' })),
        )
      }
      return [specifier, byGlobal.get(key) as string]
    }),
  )

  return cached
}
