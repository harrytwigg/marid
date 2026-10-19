import { CODENAME, LEGACY_CODENAME, isRenamed } from "./codename"

/**
 * A browser holds the operator's settings, drafts, tabs and (in the desktop app) the saved gateways
 * under keys that begin with the codename: `jinn-<name>`, `jinn.<name>` and `jinn:<name>`, some with
 * a dynamic tail (a session id, an origin, a note path). When the codename changes, code reads the
 * new prefix, so each such key is copied once to its new name. Copied, not moved: the old key stays
 * for as long as the old build might be run again.
 */

/** The separators a key's codename prefix is followed by. */
const SEPARATORS = ["-", ".", ":"] as const

/** The marker that says this storage has been through the copy. */
const MIGRATED_KEY = (codename: string): string => `${codename}.storage-migrated.v1`

/** The cache the app shell is warmed into, by an earlier build. A rename makes it an orphan. */
const LEGACY_SHELL_CACHE = `${LEGACY_CODENAME}-app-shell`

/**
 * Copy every legacy-prefixed key of `storage` to its current prefix, unless the current key exists
 * already (a newer value wins). Runs once per storage: a marker records it. Returns how many keys
 * it copied. A storage that throws (private mode, a blocked quota) is left alone.
 */
export function migrateLegacyStorage(storage: Storage, codename: string = CODENAME): number {
  if (!isRenamed(codename)) return 0
  try {
    if (storage.getItem(MIGRATED_KEY(codename)) !== null) return 0
    let copied = 0
    for (const key of storageKeys(storage)) {
      const target = currentKeyFor(key, codename)
      if (target === undefined || storage.getItem(target) !== null) continue
      const value = storage.getItem(key)
      if (value === null) continue
      storage.setItem(target, value)
      copied += 1
    }
    storage.setItem(MIGRATED_KEY(codename), "1")
    return copied
  } catch {
    return 0
  }
}

/** Every key, read before any is written, so the copy cannot be walked into its own output. */
function storageKeys(storage: Storage): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== null) keys.push(key)
  }
  return keys
}

/** The current name of a legacy-prefixed key, or undefined for any other key. */
function currentKeyFor(key: string, codename: string): string | undefined {
  const separator = SEPARATORS.find((candidate) => key.startsWith(`${LEGACY_CODENAME}${candidate}`))
  return separator === undefined ? undefined : `${codename}${separator}${key.slice(LEGACY_CODENAME.length + 1)}`
}

/** Delete the service-worker cache an earlier build named after its codename, if it is not this build's own. */
export async function deleteLegacyShellCache(
  cacheStorage: Pick<CacheStorage, "delete"> | undefined,
  codename: string = CODENAME,
): Promise<boolean> {
  if (!isRenamed(codename) || !cacheStorage) return false
  try {
    return await cacheStorage.delete(LEGACY_SHELL_CACHE)
  } catch {
    return false
  }
}

/** Run both at start-up. Called from an entry module that is imported before any code reads storage. */
export function migrateLegacyBrowserState(): void {
  if (typeof window === "undefined") return
  for (const read of [() => window.localStorage, () => window.sessionStorage]) {
    try {
      migrateLegacyStorage(read())
    } catch {
      /* storage is blocked: nothing to carry over */
    }
  }
  void deleteLegacyShellCache(typeof caches === "undefined" ? undefined : caches)
}
