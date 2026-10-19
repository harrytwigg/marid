# Plugin system: installable pages, backends, and watchers

Design round. No implementation. Base SHA `bc7a2aee`.

This document is binding on the eight implementation slices. Each slice is graded against the
section that specifies it; §12 maps which is which. Every `path:line` below was opened and
verified on this branch.

---

## 1. Existing infrastructure

Six places decide whether Jinn can host a plugin at all, and today every one of them is
closed by a literal: a fixed interface, a hardcoded `switch`, a static array, a single-entry
`Map`. That is the finding. Nothing here needs to be invented from scratch; it needs to be
opened, and the table records exactly where.

### Found and reused

| `path:line` | What it is | Why it matters here |
| --- | --- | --- |
| `packages/jinn/src/mcp/resolver.ts:113` | `buildAvailableServers(config, attachJinn)`, the built-in plus custom server map | The closest thing to a registry the repo has. A plugin registry should rhyme with it, not diverge for its own sake. |
| `packages/jinn/src/mcp/resolver.ts:175` | The `config.custom` loop | The config-driven install precedent: a user names a thing in `config.yaml` and the gateway resolves it at startup. |
| `packages/jinn/src/mcp/resolver.ts:183` | Reserved-name guard: a custom server named `jinn` is refused with a warning | Namespace-collision prior art. Plugin ids need the same treatment, and for the same reason: a caller that trusts a well-known id must not be reachable by a user-supplied one. |
| `packages/jinn/src/mcp/resolver.ts:219` | `wrapServersWithScrub(servers)`, strips `JINN_GATEWAY_TOKEN` out of third-party subprocess env | Any process a plugin causes to be spawned flows through this. §9 keeps it. |
| `packages/jinn/src/gateway/watcher.ts:28` | `syncSkillSymlinks()` | The "install by dropping a directory in the instance home" precedent, already shipped and already understood by users. Plugins copy the shape. |
| `packages/jinn/src/gateway/watcher.ts:78` | `startWatchers(callbacks)`, chokidar with `awaitWriteFinish` | The watch mechanics to reuse verbatim. |
| `packages/jinn/src/gateway/watcher.ts:79` | `const DEBOUNCE_MS = 500` | The debounce interval plugin discovery inherits, so a multi-file save is one rescan. |
| `packages/jinn/src/shared/types.ts:268` | `interface Connector`, with `start()` `:272`, `stop()` `:273`, `getHealth()` `:275`, and `id` documented at `:270` as "the connector's registry key" | The repo's de facto supervised-component contract: lifecycle, health, typed registry key, no base class. §7 mirrors it rather than inventing a second lifecycle vocabulary. |
| `packages/jinn/src/gateway/server.ts:449` | `reloadConnectorRegistry`, stop-all then re-init | The hot-reload shape a plugin backend registry follows. |
| `packages/jinn/src/gateway/api.ts:326` | `connectors: Map<string, Connector>` on `ApiContext` | A runtime-mutable, hot-reloadable registry already living on the server. Server-side prior art that a plugin registry is not a new category. |
| `packages/jinn/src/gateway/route-helpers.ts:14` | The documented contract: `handle<Domain>Api(req, res, route, context) => Promise<boolean>`, `true` means consumed | The contract a plugin router must satisfy to be a normal citizen of the dispatch chain. |
| `packages/jinn/src/gateway/api.ts:5611` | `handleCronApi(req, res, { method, pathname, url }, context)` | The uniform four-argument form of that contract, as opposed to the bespoke option bags at `:2196` and `:2198`. A plugin router uses this form. |
| `packages/jinn/src/gateway/auth.ts:264` | `if (pathname.startsWith("/api/")) return true` | Everything under `/api/` requires auth by default. This is why the plugin namespace is `/api/plugins/`, and it is load-bearing for §6 and §9. |
| `packages/jinn/src/gateway/server.ts:1098` | The gateway auth gate, `authRequiredNow() && authRequiredForRequest(...)` then 401 | Runs before `handleApiRequest` at `:1109`. Any gate mounted inside the dispatch chain is therefore downstream of auth by construction, which is exactly what §9 requires. |
| `packages/web/src/lib/route-prefetch.ts:3` | `registerRoutePrefetch(href, prefetch)`, writing a module-scope `Map` declared at `:1` | The only runtime-mutable registry in the web app with a `register*` writer, other than the single-slot Talk navigator handle at `packages/web/src/components/talk/tools/router-handle.ts:17`. Precedent that a mutable registry is an accepted pattern here, and a warning: it has no removal API, which a contribution registry cannot copy. |
| `packages/web/src/lib/nav.ts:49` | `navigationFor(notesEnabled)`, the single source for desktop, mobile, and overflow nav | `sidebar.nav` contributions merge through this function. Forking it would produce two navs that drift. |
| `packages/web/src/routes/todos/task-page/banner.tsx:90` | `actions?: React.ReactNode`, documented at `:89`, rendered at `:288`, filled from `task-page.tsx:428` | An existing page-scoped header-action slot with a `ReactNode` contract. §3's page-scoped pair generalizes this one rather than inventing a slot with no precedent. |

### Found and rejected

Recording these matters more than the reuse rows: each is a thing that looked like the answer
and is not, and the next reader would otherwise spend the same hour discovering it.

| `path:line` | What it is | Why it is rejected |
| --- | --- | --- |
| `packages/jinn/src/mcp/resolver.ts:175` | `mcp.custom`, rung 4 of the AGENTS.md §2 ladder, the extension point that exists today | **Rejected as the plugin mechanism.** It extends the *agent's* tool surface. It cannot render a page, add a nav row, or own a dashboard route. The target use case (a mailbox watcher with a drafts page and approve/reject actions) is entirely UI plus a supervised background task, and `mcp.custom` addresses neither. It remains correct for what it does and §10 keeps it. |
| `packages/jinn/src/mcp/resolver.ts:177` | `if (serverConfig.enabled === false) continue` | **Rejected as the enable semantics.** Absence means enabled here. For plugins that is the wrong default: a folder appearing in the instance home must not start executing code because nobody has said no yet. §8 inverts it. |
| `packages/jinn/src/gateway/hook-registry.ts:19` | `listeners = new Map<string, HookListener>()`, one listener per session | **Rejected as the plugin event bus.** `register()` at `:43` warns and then overwrites at `:52`, and hands the buffered payloads to the newcomer at `:61`. A plugin subscribing to a session would evict the engine's turn listener and steal its buffered `Stop` hook, so the turn would never resolve. §7 gives plugins their own bounded channel instead. |
| `packages/jinn/src/gateway/watcher.ts:7` | `interface WatcherCallbacks`, exactly four fixed hooks (`:8` to `:11`) | **Rejected as the watch registration shape.** Adding a target means editing this interface and every caller, which is the opposite of installable. The chokidar mechanics at `:78` are reused; the callback struct is not. |
| `packages/jinn/src/gateway/watcher.ts:17` | `let timer` captured inside the `debounce` closure | **Rejected as the debounce helper for plugin watchers.** `stopWatchers()` at `:135` closes the chokidar watchers and clears the array, and that is all it can do: the timer handle is unreachable from outside the closure, so a change landing within 500 ms of shutdown still fires afterwards and keeps the event loop alive. A supervised lifecycle (§7) needs a cancel path, so the plugin debounce returns a handle with `cancel()`. |
| `packages/jinn/src/gateway/server.ts:419` | `createConnector`, a hardcoded `switch` on type that throws on unknown | **Rejected as the model for plugin backends.** Connectors are a closed enum on purpose, and the comment at `:418` says so ("The only place a connector is constructed"). Plugin backends are open by definition; they load by path, not by name in a `switch`. |
| `packages/jinn/src/gateway/server.ts:267` | `serveStatic(req, res, webDir, options)` | **Rejected for plugin assets, twice over.** Its containment check at `:282` is `resolved.startsWith(path.resolve(webDir))`, a string prefix rather than a separator-aware boundary, so a sibling directory whose name merely extends `webDir` would pass. And its cache policy at `:293` marks anything under `/assets/` `immutable` for a year, which is correct for Vite's content-addressed output and exactly wrong for a plugin file that hot-reloads under a stable name. §6 serves plugin assets on their own route with `no-store`. Fixing `serveStatic` itself is not this design's business and belongs to the discovery slice if it is done at all. |
| `packages/web/src/main.tsx:106` | `createBrowserRouter([...])`, a static literal array of 27 children closing at `:144` | **Rejected as extensible.** Nothing appends to it after construction; the only conditional entry is the DEV-gated `/redesign` spread at `:141`. §3's `routes` area is what opens it. |
| `packages/web/src/lib/nav.ts:23` | `BASE_NAV_ITEMS`, a static non-exported literal | **Rejected as the place plugins add nav.** Adding a destination today means editing this literal and, for mobile placement, the `primaryHrefs` literal at `:58`. Both are inside `nav.ts` and neither is reachable from outside the module. |
| `packages/web/src/components/page-layout.tsx:123` | `PageLayout`, and its `headerActions` prop destructured to `_headerActions` | **Rejected as an existing slot.** The comment at `:115` records that no page supplies one and pages own their actions inline. It is a dead prop, not a seam. |
| **There is no status bar.** `statusbar`, `StatusBar`, and `status-bar` return zero matches across `packages/web/src`. The shell's entire persistent chrome is `NavRibbon` at `packages/web/src/components/pill-nav.tsx:235` (desktop, vertical, no right side), `MobileTabBar` (mobile only), and the floating `LiveStreamWidget`. | | **This is the one v1 area with no host in the tree.** §3 says what is built and §10 says who consumes it. |

---

## 2. Plugin anatomy

A plugin is a directory in the instance home. Nothing is installed, compiled, or registered
anywhere else.

```
~/.jinn/plugins/<id>/
  plugin.json      required   manifest
  client.js        required   plain ESM, loaded in the dashboard
  server.js        optional   plain ESM, loaded in the gateway
```

The folder name is the id. `plugin.json` repeating it is a consistency check, not a second
source of truth: a manifest whose `id` differs from its folder is a load error naming both,
not a silent preference for one. This follows the reserved-name precedent at
`packages/jinn/src/mcp/resolver.ts:183`, and `jinn` is likewise reserved.

| Field | Required | Default | Validated at discovery |
| --- | --- | --- | --- |
| `id` | yes | | matches folder name, matches `/^[a-z0-9][a-z0-9-]{1,38}$/`, not `jinn` |
| `name` | no | `id` | string |
| `version` | no | `"0.0.0"` | string |
| `client` | no | `"client.js"` | relative path, contained, distinct from `server` (§9). The field is optional; the file it names is not — a plugin with no loadable client half is an `error` record. |
| `server` | no | none | relative path, contained, distinct from `client` (§9) |

**The resolved `client` and `server` entries must be two different files.** Sameness is decided
after containment and by resolved path, not by the string the author wrote: resolve each entry
against the plugin directory with `path.resolve()` and compare the two absolute results. Equal
means the same file, whatever spelling got there — `server.js`, `./server.js`, and
`assets/../server.js` all resolve alike.

An equal pair is an `error` record for the whole plugin, naming both fields. It is deliberately
not the partial load that a rejected `server` path gets (§9 guard 2): a plugin that points both
halves at one file has no half that is safe to keep.

So the manifest `{"client": "server.js", "server": "server.js"}` never loads. Both entries are
relative, both are contained, and both resolve to `<plugin>/server.js`; the comparison finds them
equal and discovery stops there with an error naming `client` and `server`. Without this rule
that manifest would be valid, and `GET /api/plugins/<id>/client` would serve the gateway-side
source verbatim — the one thing §6 says that route cannot do.

There is no manifest field that enables a plugin. §8 explains why: the manifest is written by the
plugin, and a plugin does not get to opt itself in.

Discovery produces an inventory record per directory, `{id, name, version, kind, status, error}`,
where `kind` is `client` or `client+server` and `status` is one of `loaded`, `disabled`, `error`. A
directory that fails validation still gets a record carrying its error, because a plugin that
vanishes from the settings list when it breaks is a plugin nobody can fix.

Both halves are plain ESM with no build step. That is the point: it is what lets an agent
write a working plugin by writing one file. The cost is stated in §4.

`client.js` default-exports `{ id, name?, register(ctx) }`. `server.js` default-exports a route
registrar and may additionally export `watcher` (§7).

---

## 3. The Contribution model

A contribution is one thing a plugin adds to one place in the UI.

```ts
interface Contribution {
  id: string                    // unique within its area; re-registering the same id replaces it
  area: string                  // dotted area id, from the SDK's area constants
  order?: number                // ascending; `order ?? 0`, ties keep insertion order
  when?: () => boolean          // visibility predicate, evaluated when the area snapshot is rebuilt
  render?: () => ReactNode      // UI contributions
  data?: unknown                // declarative payload, shape defined per area
}
```

`source` is not an author field. The host stamps it (`core` or `plugin:<id>`) along with the
namespaced id, so a contribution cannot lie about where it came from. Provenance is a tag for
display and for the future capability gate, and §9 is explicit that it is not a gate today.

There is deliberately no `enabled` field. `when: () => false` already expresses a soft hide,
and plugin-level enablement belongs to the gateway and `config.yaml` (§8), not to each
contribution. One mechanism, not two.

**`when` is not reactive, and the spec says so out loud.** It is evaluated when the area's
snapshot is rebuilt, which happens on a register or remove *in that area*. A `when()` that
depends on external state will not re-resolve on its own. Authors who need reactive visibility
render a component that returns `null`.

**Area-scoped invalidation is a requirement, not an optimization.** Snapshots are cached per
area and invalidated only for the area that mutated, so registering a status-bar chip cannot
re-render the routes area. Snapshot identity has to be stable across reads for
`useSyncExternalStore` to work at all; without the cache, every store read returns a fresh
array and React re-renders forever.

### The four v1 areas

| Area | Id(s) | Payload | Host site today |
| --- | --- | --- | --- |
| Full page | `routes` | `data: { path }` plus `render` | `packages/web/src/main.tsx:106`. Contributed paths are reserved the same way the static children are, so a plugin cannot shadow `/todos`. One absolute segment, no params. |
| Sidebar nav | `sidebar.nav` | `data: { path, label, icon }` | Merged inside `packages/web/src/lib/nav.ts:49` so desktop, mobile, and overflow all see it. Pairs with a `routes` contribution; the row navigates to `path` and lights up while the app is there. |
| Status bar | `statusbar.right` | `render`, or `data` for a plain label chip | **No host exists.** The registry slice builds the bar and mounts it in `packages/web/src/components/page-layout.tsx:130`, inside `<main>`, which is the only sane mount point. See §10 for why this is not speculative. |
| Todo detail, page-scoped pair | `todo.detail.actions` and `todo.detail.sections` | `render` | `banner.tsx:288` (the existing `actions?: ReactNode` slot, declared `:90`) and `task-page.tsx:567`, immediately above `ActivitySection` in the ordered section stack. |

The pair is one surface with two ends, header and body, and it is the shape a plugin needs to
add both an action and the thing the action operates on. It is scoped to a page, so it
demonstrates that areas are a scene graph and not a flat list of global chrome.

One hazard for the pair, from the host site: `PropsRail` is rendered twice in
`task-page.tsx`, mobile at `:553` and desktop at `:579`. A slot placed naively next to it
would double-render. `todo.detail.sections` is anchored at `:567`, which is rendered once.

### Error isolation

Every contribution's `render()` is wrapped in its own boundary, in a `chip` or `pane` variant
sized to the slot. A throwing contribution degrades inside its own slot with a Retry and takes
nothing else down. Gateway event listeners are try/caught per listener for the same reason.
This is the whole of the isolation story, and §9 is blunt about what it does not buy.

---

## 4. The SDK import surface

One module, `@jinn/plugin-sdk`, is the only thing a plugin may import. It re-exports:

- React and the jsx runtime, **the app's instances**. A second React would break hooks, so this
  is not a convenience re-export, it is the mechanism.
- The query client, the `components/ui` primitives worth exposing, and `cn`.
- The area constants from §3.
- The `host` object (§5).

Two delivery modes resolve to the same object:

1. **Bundled**, for anything shipped in-repo: the specifier resolves through a Vite alias at
   build time. Real JSX works.
2. **Runtime**, for a `client.js` on disk: the loader installs the live SDK, React, and the jsx
   runtime on globals, then generates a small ESM blob per global that re-exports the live
   namespace. Export names are derived from `Object.keys()` of the namespace so the shim cannot
   drift from what the SDK actually exports.

The loader rejects unsupported bare specifiers **up front, with a named error**, before
evaluating anything. Only `@jinn/plugin-sdk`, `react`, and `react/jsx-runtime` resolve. The
specifier rewrite is anchored to import and export syntax so a matching string literal inside
the plugin is never touched. A lint fence keeps bundled plugins to the same list, so the two
modes cannot diverge into "works bundled, fails on disk".

The public type contract is a hand-authored `.d.ts`, never derived from internals. Deriving it
leaks internal import paths into the public API and turns an internal rename into a silent
breaking change. It carries an explicit version.

**The no-build tax, stated plainly:** a disk plugin is not compiled, so JSX syntax will not
parse in it. Authors call `jsx()` or `createElement`. Adding a transpile step is a follow-up
(§11), not a v1 requirement, because the door being open matters more than the syntax being
pretty.

---

## 5. The host API

Plugins do not get raw RPC. **"Upstream" throughout this document is Hermes, and every upstream
citation is a path relative to the Hermes repository root, never to this one.** Hermes exposes
`host.request(method, params)` and calls it "the plugin's real power"
(`apps/desktop/src/sdk/index.ts:16`); it is also the reason a permission model there has to be
retrofitted against an untyped surface. Jinn ships typed verbs from day one:

```
host.todos.list(query) / .create(input) / .comment(id, body)
host.sessions.spawn(input)      // records plugin provenance on the session
host.employees.list()
host.notify(message, level)
host.navigate(path)
host.onEvent(type, handler)     // per-listener try/catch isolation
host.state.*                    // readonly: active session, gateway status
```

The same verbs exist on the plugin server context, so the mailbox use case is expressible on
either side: the watcher sees mail, `host.sessions.spawn` drafts a reply, and a UI action calls
the plugin's own backend route to send it.

Three tiers, in increasing authority: readonly state, curated actions, and the typed verb door.
Every verb is named, typed, and individually deniable later. v1 allows all of them; the seam is
the point, not the policy. This is the one place the design deliberately costs more than
copying upstream, and the reason is that an untyped door cannot be narrowed afterwards without
breaking every plugin at once.

Note the interaction with `packages/jinn/src/mcp/resolver.ts:219`: anything a plugin causes to
be spawned still flows through `wrapServersWithScrub`, so `JINN_GATEWAY_TOKEN` does not reach a
third-party subprocess by way of a plugin.

---

## 6. Backend namespace: `/api/plugins/<id>/*`

An enabled plugin's `server.js` mounts under `/api/plugins/<id>/`. The module default-exports a
route registrar that receives `{ id, log, storage, settings }`, where `storage` is namespaced to
the plugin and `settings` is its slice of `config.yaml`.

**Mounting.** One `handlePluginsApi(req, res, route, context) => Promise<boolean>` satisfies the
contract documented at `packages/jinn/src/gateway/route-helpers.ts:14`, in the uniform
four-argument form used at `packages/jinn/src/gateway/api.ts:5611`. It joins the boolean chain
in `handleApiRequest` as one more link. No new dispatch mechanism, no route table.

**Hot reload.** The registrar is re-imported with a cache-busting query on file change, and the
previous incarnation's routes are dropped. This is a strict improvement over upstream, where the
plugin backends are mounted once from module scope at process start
(`hermes_cli/web_server.py:17315`), so a code change needs a restart and a rescan will not do it.
Jinn gets it for free by being one language on both sides.

**Namespacing by construction.** The client-side helper takes a path relative to the plugin's own
prefix and builds `/api/plugins/<id><suffix>`. A `..` segment in the path (checked on the portion
before `?` or `#`) **throws** rather than being sanitized, because a silently rewritten path is a
bug that reaches production and a thrown error is one that does not. Today the namespace is the
boundary; §9 says what that does and does not mean.

**Assets.** Plugin assets are served at `/api/plugins/<id>/assets/*`, not at a top-level
`/plugin-assets/` route. **The root of that route is the plugin's `assets/` subdirectory, not the
plugin directory.** A request for `/api/plugins/<id>/assets/logo.svg` resolves under
`<plugin>/assets/`, and no path under the route can name the plugin root. The client half has its
own path, `/api/plugins/<id>/client`, which takes no caller-supplied path at all: it resolves to
exactly one file, the manifest's `client` entry (§2).

`server.js` lives in the plugin root beside `client.js` (§2) and is addressable by neither route.
The assets route cannot name it because that route's root is `<plugin>/assets/` and the plugin
root is above it. `/client` cannot name it because §9's guard 2 rejects any plugin whose `client`
and `server` entries resolve to the same file, so the single file `/client` resolves to is, by
construction, not the one the gateway imported. Neither half of that is an assertion about
authors behaving; both are checks that run before the plugin loads.

That routing, not the suffix allowlist in §9, is what keeps backend source off the wire — an
allowlist that has to contain `.js` so the client half can load cannot also be the thing that
withholds a `.js` backend.

This is a correction to the shape the discovery slice's brief currently describes, and the reason is concrete:
`authRequiredForRequest` (`packages/jinn/src/gateway/auth.ts:251`) returns `true` only for paths
under `/api/` (`:264`) or `/ws` (`:265`), and `false` otherwise (`:266`). A `/plugin-assets/...`
route therefore never reaches the auth gate at `packages/jinn/src/gateway/server.ts:1098` and
would be served to anyone who can reach the port. Upstream accepts an asset path that is
unauthenticated in its default loopback mode, and says why in the route's own docstring: its SPA
loads plugin code through `<script src>` and `<link href>`, neither of which can attach a header
(`hermes_cli/web_server.py:17121`). Jinn's loader (§4) `fetch`es the module and imports a blob URL, so it *can*
attach the gateway token, and the namespace that gets auth for free is the one under `/api/`.

The suffix allowlist in §9 stays regardless. Auth and the allowlist answer different questions:
auth decides who may ask, the allowlist decides what may be answered.

**Live updates.** A plugin backend calls `ctx.emit(event)`, which appends to a bounded per-plugin
ring with a monotonic cursor, exposed at `WS /api/plugins/<id>/events?since=<cursor>`. That path
is under `/api/`, so `authRequiredForRequest` returns `true` and the upgrade gate at
`packages/jinn/src/gateway/server.ts:1189` authenticates it with no bespoke token check. The
cursor makes polling a complete fallback, so the socket is an accelerator and never the only way
to see an event.

---

## 7. Supervised watcher lifecycle

The mailbox use case needs something watching a folder when no page is open. This is the
capability upstream lacks entirely: its plugin contract is `register(ctx)` and nothing else
(`apps/desktop/src/contrib/plugin.ts:100`), so plugins there hand-roll their own threads, and the
flagship plugin's dispatcher ended up in gateway core (`gateway/kanban_watchers.py:953`) because
there was nowhere else for it to live.

`server.js` may export `watcher: { start(ctx), stop() }`. The contract is deliberately the one
already in the tree at `packages/jinn/src/shared/types.ts:268`: `start()` `:272`, `stop()`
`:273`, and health readable the way `getHealth()` `:275` is readable, keyed by id the way `:270`
documents. Same vocabulary, so a reader who knows connectors knows this.

The gateway owns the lifecycle:

- **Start** on enable and on gateway boot, never from module evaluation. Importing a file must
  not start a background task.
- **Stop** on disable, on reload, and on shutdown. `stop()` is awaited with a timeout; a watcher
  that will not stop is logged and abandoned, not waited on forever.
- **Restart** on crash with capped exponential backoff. After the cap the watcher stays down and
  its inventory record says so. A watcher that silently gave up is worse than one that is
  visibly dead.
- **A watcher exception can never reach the gateway's top level.** Both `start()` and the
  supervisor's own timers are wrapped.

### Hot-reload hazards, enumerated because each one has bitten somebody

1. **Id changed on a hot edit.** Reloading disposes the *new* id, so the previous incarnation's
   contributions orphan. The loader tracks the previous id across a reload and disposes that.
2. **Ghost error records.** Closed by construction rather than by a branch: the dashboard keeps
   no records at all, and the gateway keys its inventory by folder name, so a directory and the
   id it happens to load under can never become two rows.
3. **Re-entrant scans.** A rescan must not overlap a slow in-flight scan; reads and dynamic
   imports can exceed the debounce interval. A `scanning` guard, not a shorter interval.
4. **Unwatchable or absent directory.** `~/.jinn/plugins/` may not exist. Absent is not an error,
   it is zero plugins. Unwatchable degrades to an explicit rescan action in the settings page
   rather than a silent no-op.
5. **Folder deleted mid-flight.** Discovery reads a manifest that disappears before the import.
   Treated as "not installed", not as a load error.
6. **Pending debounce timers surviving stop.** The hazard recorded in §1 against
   `packages/jinn/src/gateway/watcher.ts:17`. The plugin debounce returns a handle with
   `cancel()`, and the supervisor calls it during stop, so shutdown does not fire a rescan into a
   torn-down registry.

---

## 8. Enable and disable in `config.yaml`

```yaml
plugins:
  enabled: [inbox-demo]
  disabled: []
```

**Absence is not enabled.** The two lists are the operator's explicit decisions, and they are the
only input to the decision: a plugin named in neither is disabled. Nothing the plugin ships can
change that, and nothing it ships even mentions it: neither the §2 manifest nor the module has a
field for enablement, because a shipped value that flipped an unlisted plugin to enabled would be
the plugin opting itself in, and only the operator gets to do that. This deliberately inverts
`packages/jinn/src/mcp/resolver.ts:177`, where `enabled === false` means
absence is enabled. The difference is that an MCP server is something the operator already wrote
into their config by hand, whereas a plugin directory can arrive by being copied. `disabled`
wins over `enabled` when a plugin somehow appears in both, because the fail-closed reading is
the safe one.

The file is watched today at `packages/jinn/src/gateway/watcher.ts:81`, so a decision takes
effect without a restart.

**One policy, three enforcement points**, and all three are required because each closes a
different window:

| Point | What it stops |
| --- | --- |
| Discovery and mount | A disabled plugin's `server.js` is never imported. Import is execution; gating any later is gating after the code has already run. |
| Request time (§9) | A plugin disabled *while the gateway is running* has routes already mounted. Only a per-request check makes a live toggle real. |
| Asset serving | Neither route in §6 answers for a disabled plugin: its client entry and its assets are both 404, so a stale dashboard tab cannot resurrect it by reloading the module. |

A disabled plugin still appears in the inventory. Disabled is a state, not an absence.

---

## 9. Security posture

**This is error isolation. It is explicitly not a capability boundary.**

A loaded plugin is evaluated as ESM in the dashboard's own realm with the app's full authority:
the React singleton, the whole SDK, the host verbs, the gateway token the dashboard already
holds. `server.js` is imported into the gateway process and can do anything the gateway can. The
boundaries in §3 and §7 stop a plugin from *crashing* the app; they do not stop it from *acting
as* the app. Nothing in this design changes that, and no future section should be read as
implying otherwise.

That is acceptable for the v1 threat model and only for it: plugins are local directories the
operator put in their own instance home, and a local file can already run code. It stops being
acceptable the moment a plugin can arrive from anywhere else, which is why remote plugins are a
non-goal (§11) rather than a later feature of the same pipeline. A real boundary means an iframe
or worker, a CSP, and capability gating, and it is a different pipeline, not a flag on this one.

Three lessons carried over from upstream's actual incidents. Each is a rule plus the concrete
thing it prevents.

**1. Asset suffix allowlist.** Under `/api/plugins/<id>/assets/*`, serve only `.js`, `.mjs`,
`.css`, `.json`, `.svg`, `.png`, and `.woff2`. Everything else is a 404, not a 403, so the
response does not confirm the file exists.
*Prevents:* handing out whatever else ends up in a plugin's `assets/` directory — a dropped
`.env`, a key, an editor backup, a `.map` pointing at unminified source. It is deliberately not
what protects `server.js`: `.js` has to be on this list for the client half to load, so backend
source is kept unreachable by the asset root in §6 instead. Upstream shipped an asset route
rooted at the whole plugin directory, which returned 200 for any file in it including the Python
backend module, and the fix there was to restrict the suffix rather than to add auth, because
that route could not carry a header (`hermes_cli/web_server.py:17125`). We take the suffix rule
and the narrower root both. Add to the set deliberately when a new asset type comes up; never
change the default fallback.

**2. Traversal, absolute-path, and distinct-entry guard, at discovery and again at mount.** The
manifest's `client` and `server` fields are attacker-influenced input. Reject a non-string or
blank value, reject `path.isAbsolute()`, then `path.resolve()` and require the result to be
*contained within* the plugin directory using a separator-aware check, not the string prefix used
at `packages/jinn/src/gateway/server.ts:282`. Then, when both fields are present, compare the two
resolved paths and reject the plugin outright if they are equal (§2). Re-resolve at mount time as
well — containment and the comparison both, on the same re-resolved paths, for the same reason.
*Prevents:* the exact upstream RCE (`hermes_cli/web_server.py:16566`). An absolute path swallows
the base entirely, because `join("plugins/safe", "/tmp/evil.js")` resolves to `/tmp/evil.js`, and
the mount imports whatever it is handed. A `../..` climbs into a neighbouring directory. Upstream
was hit through its single manifest backend-path field; the guard here covers `client` as well,
because both fields reach a resolver and only one of them being validated is how the second one
gets forgotten. Re-checking at mount covers the
window where the cached directory was tampered with after validation, or where a future caller
reaches the mount without passing through the validator.

*The comparison prevents* a second exposure the containment check cannot see, because the path is
contained and legal: `{"client": "server.js", "server": "server.js"}`, where the plugin publishes
its own backend as its client half and `GET /api/plugins/<id>/client` hands the gateway-side
source to any authenticated caller (§6). Every entry that reaches a resolver here is compared
against the other one for the same reason both are containment-checked.

A plugin whose `server` path fails containment still loads its client half, with the rejection
recorded on its inventory row. That partial load is for containment failures only: an equal pair
fails as a whole plugin (§2), since keeping the client half is precisely what would serve the
backend file.

The enabling bug upstream is worth carrying too (`hermes_cli/web_server.py:16617`): the opt-in env
var that unlocked untrusted project plugins was read with a plain truthiness test, so `=0`,
`=false`, and `=no` all *enabled* the untrusted source. Any boolean that gates plugin loading
parses against an explicit true set, never truthiness.

**3. The runtime enable gate runs strictly after auth.** The per-request check from §8 is
positioned so that an unauthenticated request receives auth's 401 and never the gate's 404.
*Prevents:* an installed-plugin oracle. If the gate ran first, an anonymous caller could walk
`/api/plugins/<guess>/` and read enabled-versus-not off the status code, learning which plugins
the operator has installed without ever authenticating. In this tree the ordering is structural
rather than a convention to remember: the auth gate at
`packages/jinn/src/gateway/server.ts:1098` returns 401 before `handleApiRequest` is called at
`:1109`, so a gate living in the dispatch chain is downstream of it by construction. The gate
also fails closed on an unknown plugin id, which is a 404 for the same reason.

Two attributions, corrected here because the discovery slice's brief has them the other way round and copying
a wrong citation into shipped code comments is how the next reader gets misled:

- `GHSA-5qr3-c538-wm9j` is the manifest path traversal and absolute-path RCE (lesson 2), named in
  upstream's own guard at `hermes_cli/web_server.py:16571`.
- `GHSA-mcfc-hp25-cjv7` is the enable-gate bypass, where assets were served
  (`hermes_cli/web_server.py:17131`) and backend code imported (`:17217`) without checking the
  enabled allowlist (lesson 3's first half).
- The asset suffix allowlist (lesson 1) has **no advisory id**; it came from a pentest self-test,
  which upstream's own regression test records as such (`tests/hermes_cli/test_web_server.py:3748`).
  It is a real fix and not a real CVE, and the spec should not inflate it into one.

---

## 10. Why this is not speculative infrastructure

AGENTS.md §3 rejects any extension point without a named consumer that exists in this tree
today, and a plugin system is the archetype of what that rule is aimed at. The answer is that
core surfaces register through the same contribution API, so every area ships with a real
consumer before any plugin exists.

| Area | Consumer in this tree, on day one |
| --- | --- |
| `routes` | The static children of `packages/web/src/main.tsx:106`. At minimum one existing page is migrated to a core contribution, so the area has a live consumer and the migration proves the area can carry a real page rather than a demo. |
| `sidebar.nav` | `packages/web/src/lib/nav.ts:23` already builds the nav from a list. `navigationFor` at `:49` merges core contributions with plugin ones, and its three production consumers (`pill-nav.tsx:243`, `mobile-tab-bar.tsx:39`, `more/page.tsx:21`) are unchanged. |
| `statusbar.right` | The bar does not exist, so it is built with its own core contributions: the workspace switcher and theme toggle currently pinned at `packages/web/src/components/pill-nav.tsx:348` move into it. The bar is not built *for* plugins; it is built because those two controls are the only persistent status affordances the app has and they are currently wedged into the bottom of a nav rail. A plugin chip is then the second consumer, not the first. |
| `todo.detail.actions` / `.sections` | `packages/web/src/routes/todos/task-page/banner.tsx:90` is an existing named `ReactNode` slot filled from `task-page.tsx:428`. Generalizing a slot that already has a caller is the second-caller rule, not a guess. |
| The host API (§5) | Each verb wraps an endpoint the dashboard already calls. No verb is added without one. |
| The whole system | The reference plugin (the settings and reference-plugin slice) exercises every area, both halves, and the supervised watcher. It is committed in-repo and runs in CI, so an area with no core consumer still has a test that fails when it breaks. |

If an area cannot name a consumer, it does not ship. That is the rule this section exists to
satisfy, and it is what shrank the area list to four.

---

## 11. v1 non-goals

| Not in v1 | Why deferred |
| --- | --- |
| Themes | Jinn's theming is CSS custom properties in two theme blocks, not a registry. A theme contribution would be a second theming system competing with the tokens, and nothing has asked for one. |
| Keybinds | There is no global keybinding layer to contribute into; building one is its own design, and a plugin-only shortcut registry would be the speculative half of it. |
| Command palette | The app has global search, not a command palette. Contributing commands requires the palette to exist first. |
| Panes | The shell is one route at a time (`packages/web/src/main.tsx:106`). A dockable pane tree is a shell rewrite that dwarfs the plugin system and must not be smuggled in as a plugin area. |
| SRI | Integrity hashes prove the bytes match a hash; they do not sandbox, and for a local file the operator already controls, they verify nothing an attacker could not also update. It is the transport seam for remote plugins, so it lands with them or not at all. |
| Remote plugins | §9 is the reason. This pipeline has no trust boundary, so a remote source cannot reuse it as-is. Remote needs an iframe or worker, a CSP, and capability gating first. |
| A JSX build step for disk plugins | §4's tax. The no-build door is what makes plugins writable by an agent in one file; a transpiler is an optimization on top of a door that has to be open first. |
| A permission or consent UI | The typed verbs in §5 are the seam. v1 allows all of them. Building the UI before anything is denied would be a config nobody sets. |

---

## 12. Slice map

Each slice is graded against its section.

| Slice | Section | Deliverable |
| --- | --- | --- |
| Registry | §3 | Contribution registry, area-scoped invalidation, `Slot`, error boundaries, and the status bar host |
| SDK | §4, §5 | `@jinn/plugin-sdk`: the single import surface and the hand-authored `.d.ts` |
| Loader | §4 | Runtime loader: specifier rejection, shims, blob import, validation, hot reload |
| Discovery and assets | §2, §6, §8, §9 | Discovery, manifest validation, `GET /api/plugins`, asset route with the three guards, config lists |
| Backend mount | §6, §8, §9 | Backend mount, hot reload, runtime enable gate after auth, per-plugin error isolation |
| Watcher | §7, §6 | Supervised watcher lifecycle and the per-plugin event channel |
| Host verbs | §5 | The typed host verbs, on both the client and the server context |
| Settings and reference plugin | §10 | Settings page, the reference plugin, and `docs/plugins.md` |

Two corrections this design makes to briefs already written, so they are not lost when those slices are
picked up: the asset route moves under `/api/` (§6), and the CVE attributions in the discovery slice's brief are
swapped (§9).
