/* Imported by the generated service worker. A template: the build writes it as sw-shell-warm.js with the
 * codename in place (vite.config.ts, `shellWarmScript`), so the cache it fills is named like the one the
 * navigation rule below reads, and an earlier codename's cache can be told from this one's.
 *
 * Navigations are network-first so a deploy lands on the next reload rather
 * than the one after it, which means the offline fallback lives in a runtime
 * cache — and a runtime cache is only written by navigations the worker
 * intercepted. The navigation that installs the worker is not one of them, so
 * without this an app that has been opened exactly once has no shell to fall
 * back to. Fetching the document here also pins it to the same install that
 * precaches the chunks it references, so the two can never disagree offline. */
const SHELL_CACHE = '__CODENAME__-app-shell'
const SHELL_KEY = '/index.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch(SHELL_KEY, { cache: 'no-store' })
      if (!response.ok) throw new Error(`shell warm-up failed: ${SHELL_KEY} returned ${response.status}`)
      await (await caches.open(SHELL_CACHE)).put(SHELL_KEY, response)
    })(),
  )
})
