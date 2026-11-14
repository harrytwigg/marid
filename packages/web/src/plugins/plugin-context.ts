/**
 * The plugin authoring contract, and the scoped context a plugin registers
 * through.
 *
 * A plugin never reaches the registry itself — it only ever holds a
 * `PluginContext`, whose `contribute` namespaces the id and stamps the source
 * on the way past. That is what makes `.plans/plugins.md` §3's rule true rather
 * than merely stated: an author has no way to write `source`, and no way to
 * spell an id outside their own namespace.
 */
import { contributions } from '@/contrib/registry'
import type { Contribution, ContributionSource } from '@/contrib/types'
import { authFetch } from '@/lib/auth'
import { gatewayTransport } from '@/lib/gateway-transport'
import type { KVStore } from '@/lib/view-mode'

/** Namespaced JSON persistence. Keys live under `hundredfold.plugin.<id>.`, so one
 *  plugin can neither read nor clobber another's. */
export interface PluginStorage {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
}

/** One event a plugin's backend passed to `ctx.emit`. */
export type PluginEventHandler = (event: unknown) => void

export interface PluginEventsOptions {
  /** Replay from this cursor rather than from everything the ring still holds. */
  since?: number
}

/** A frame from `/api/plugins/<id>/events`, matching the gateway's
 *  `PluginEventPage` (plugins/event-log.ts). */
interface PluginEventFrame {
  events?: { cursor: number; event: unknown }[]
}

export interface PluginContext {
  /** The tag this context stamps, e.g. `plugin:cost-meter`. */
  readonly source: ContributionSource
  /** Register one contribution. Its `id` is local — the host namespaces it. */
  contribute: (contribution: Contribution) => () => void
  /** Register several at once; the returned disposer removes all of them. */
  contributeMany: (contributions: readonly Contribution[]) => () => void
  /** Register a cleanup for a side effect that is not a contribution — a timer,
   *  a subscription — so unload and reload take it down with everything else. */
  onDispose: (dispose: () => void) => void
  storage: PluginStorage
  /** Call this plugin's own backend, at a path relative to its mount. A plugin
   *  cannot spell another's prefix, because it never supplies the id. */
  backend: (suffix: string, init?: RequestInit) => Promise<Response>
  /** Watch this plugin's own event stream — every value its backend passed to
   *  `ctx.emit`. Returns an unsubscribe, so an effect can return it directly.
   *  Namespaced the way `backend` is: there is nowhere in this signature to put
   *  another plugin's id. */
  events: (handler: PluginEventHandler, options?: PluginEventsOptions) => () => void
}

/**
 * Does this segment read as `..` to the URL parser?
 *
 * `%2e` decodes to `.` during path normalization, so WHATWG URL collapses four
 * spellings — `..`, `.%2e`, `%2e.`, `%2e%2e` — and a literal-only check leaves
 * three ways to walk out of the mount that `fetch` still honours. `%2e%2e%2e` is
 * not one of them: three dots is an ordinary segment, and refusing it would
 * refuse a legal path.
 */
function isParentSegment(segment: string): boolean {
  return segment.toLowerCase().replaceAll('%2e', '.') === '..'
}

/**
 * `/api/plugins/<id><suffix>`, refusing rather than rewriting a suffix that
 * walks out of the plugin's own mount.
 *
 * The check reads the path alone — everything before `?` or `#` — because a
 * relative path passed as a query *value* is a legitimate thing to send, and
 * only the path decides what the request reaches. Sanitizing would answer a
 * different request than the caller wrote, which is a bug that reaches
 * production; throwing is one that does not.
 *
 * Segments break on `\` as well as `/`, because for an http URL the WHATWG
 * parser treats a backslash as a path separator too. Splitting on `/` alone
 * reads `..\other` as one ordinary name and lets the parent segment through;
 * `%5c` is not a separator, so it stays a literal and needs no such reading.
 */
export function pluginBackendPath(pluginId: string, suffix: string): string {
  const [routePath = ''] = suffix.split(/[?#]/, 1)
  if (routePath.split(/[/\\]/).some(isParentSegment)) {
    throw new Error(
      `[plugin] "${suffix}" contains a ".." segment, encoded or not, and would leave ` +
        `/api/plugins/${pluginId}/. Pass a path relative to the plugin mount, without ".." segments.`,
    )
  }
  return `/api/plugins/${pluginId}${suffix}`
}

/**
 * The socket URL for one plugin's event stream.
 *
 * No token rides on it, deliberately: the path is under `/api/`, so the
 * gateway's single upgrade gate has already authenticated the caller by the time
 * the socket exists (gateway/server.ts), exactly as it does for `/ws`.
 *
 * Exported so a test can read the URL a context builds rather than infer it.
 */
export function pluginEventsUrl(pluginId: string, since?: number): string {
  const query = since === undefined ? '' : `?since=${encodeURIComponent(String(since))}`
  return gatewayTransport().socketUrl(`/api/plugins/${pluginId}/events${query}`)
}

function subscribeToPluginEvents(
  pluginId: string,
  handler: PluginEventHandler,
  options?: PluginEventsOptions,
): () => void {
  const query = options?.since === undefined ? '' : `?since=${encodeURIComponent(String(options.since))}`
  const socket = gatewayTransport().openSocket(`/api/plugins/${pluginId}/events${query}`)

  socket.addEventListener('message', (frame: MessageEvent) => {
    let page: PluginEventFrame
    try {
      page = JSON.parse(String(frame.data)) as PluginEventFrame
    } catch (error) {
      // A frame we cannot read is one we cannot deliver. Dropping it silently
      // would leave a plugin waiting for an event that already arrived.
      console.warn(`[plugin] ${pluginId} received an unreadable event frame`, error)
      return
    }
    // The cursor stays inside the transport: a plugin is handed what it emitted,
    // not the ring position it landed in.
    for (const record of page.events ?? []) handler(record.event)
  })

  // Closing a socket that has not finished connecting aborts it, so an
  // unsubscribe during mount needs no readyState dance.
  return () => socket.close()
}

/** What a plugin's `client.js` default-exports. */
export interface HundredfoldPlugin {
  /** Stable slug. It becomes the `plugin:<id>` source and the id namespace. */
  id: string
  /** Human name. Checked for type when present; `/settings/plugins` labels a
   *  plugin from its manifest, so nothing in the app reads this one today. */
  name?: string
  /** Called once per activation; wire contributions through `ctx`. */
  register: (ctx: PluginContext) => void
}

function defaultStore(): KVStore | null {
  return typeof localStorage !== 'undefined' ? localStorage : null
}

function createPluginStorage(pluginId: string, store: KVStore | null): PluginStorage {
  const scoped = (key: string) => `hundredfold.plugin.${pluginId}.${key}`

  return {
    get(key, fallback) {
      const raw = store?.getItem(scoped(key))
      if (raw === null || raw === undefined) return fallback

      try {
        return JSON.parse(raw) as typeof fallback
      } catch {
        // A value we cannot parse is one we cannot honour. The fallback is the
        // plugin's own stated answer for "nothing stored", which is the closest
        // true thing to say about a value that is there but unreadable.
        return fallback
      }
    },
    set: (key, value) => store?.setItem(scoped(key), JSON.stringify(value)),
  }
}

/**
 * Build the context handed to one plugin's `register`. `track` receives every
 * disposer the plugin accumulates, which is how the loader takes an incarnation
 * back down on unload or reload.
 */
export function createPluginContext(
  pluginId: string,
  track?: (dispose: () => void) => void,
  store: KVStore | null = defaultStore(),
): PluginContext {
  const source: ContributionSource = `plugin:${pluginId}`
  const scope = (contribution: Contribution): Contribution => ({
    ...contribution,
    id: `${pluginId}:${contribution.id}`,
  })

  const tracked = (dispose: () => void) => {
    track?.(dispose)
    return dispose
  }

  return {
    source,
    contribute: (contribution) => tracked(contributions.register(scope(contribution), source)),
    contributeMany: (batch) => tracked(contributions.registerMany(batch.map(scope), source)),
    onDispose: (dispose) => void tracked(dispose),
    storage: createPluginStorage(pluginId, store),
    backend: (suffix, init) => authFetch(pluginBackendPath(pluginId, suffix), init),
    events: (handler, options) => tracked(subscribeToPluginEvents(pluginId, handler, options)),
  }
}
