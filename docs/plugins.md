# Plugins

A Jinn plugin is a directory you drop into your instance home. There is no package to publish, no build to run, and no registry to talk to: the gateway finds the directory, the dashboard evaluates one JavaScript file, and the plugin starts adding pages, sidebar rows, and status chips to the app you already have running. A plugin may also ship a second file that runs inside the gateway, giving it HTTP routes and a supervised background task.

The design goal is that an agent can write a working plugin by writing one file. Everything below follows from that.

> **Error isolation, not a sandbox.** A loaded plugin runs with the app's full authority in both halves. The boundaries described here stop a plugin from crashing Jinn; they do not stop it from acting as Jinn. Read [Security posture](#security-posture) before you install anything you did not write.

---

## Anatomy

A plugin is a directory under `~/.jinn/plugins/`, named for its id:

```
~/.jinn/plugins/<id>/
  plugin.json      required   manifest
  client.js        required   plain ESM, evaluated in the dashboard
  server.js        optional   plain ESM, imported into the gateway
  assets/          optional   static files served at /api/plugins/<id>/assets/*
```

The folder name is the id. `plugin.json` repeats it as a consistency check, not as a second source of truth: a manifest whose `id` disagrees with its folder is a load error naming both, rather than a silent preference for one.

```json
{
  "id": "inbox-demo",
  "name": "Inbox",
  "version": "1.0.0",
  "client": "client.js",
  "server": "server.js"
}
```

| Field | Required | Default | Validated at discovery |
|-------|----------|---------|------------------------|
| `id` | yes | | matches the folder name, matches `/^[a-z0-9][a-z0-9-]{1,38}$/`, and is not `jinn` (reserved for the gateway) |
| `name` | no | the id | non-empty string, shown in the settings list |
| `version` | no | `"0.0.0"` | non-empty string |
| `client` | no | `client.js` | relative path, resolving inside the plugin directory |
| `server` | no | none | relative path, resolving inside the plugin directory, and a different file from `client` |

The `client` field is optional; the file it names is not. A directory with no loadable client half is still inventoried, with `status: "error"` and the reason on the row. That is deliberate: a plugin that disappeared from the settings list the moment it broke would be a plugin nobody could fix.

Absolute paths and paths that escape the plugin directory are rejected, and containment is re-checked against the resolved real path so a symlink cannot smuggle an entry out. If only the `server` entry fails containment, the plugin still loads its client half and carries the rejection on its inventory row. A manifest that points both entries at one file fails as a whole, because keeping the client half is precisely what would publish the gateway-side source over `GET /api/plugins/<id>/client`.

The worked reference plugin lives at [`examples/plugins/inbox-demo/`](../examples/plugins/inbox-demo/), with all three files in the shape described here. Copy that directory into `~/.jinn/plugins/` to start from something that runs.

---

## Writing JSX, without a build step

**You can write JSX in a disk plugin.** `<Card>` is a component, not a syntax error.

The plugin directory still has no build step of its own: nothing to install, nothing to watch, nothing to run before a save takes effect. The compile happens on the gateway, when `GET /api/plugins/<id>/client` serves the file. A `client.js` that is already plain ESM is not compiled at all — it is streamed from disk byte for byte, so what the browser evaluates is what you wrote. Output is cached against the file's size and modification time, so an unchanged file is compiled once and an edit is picked up on the next request.

Two constraints come with it:

- **`react/jsx-dev-runtime` is not importable.** The compile uses the automatic runtime's production form, which emits `react/jsx-runtime` — one of the three specifiers the loader resolves to the app's own live namespaces. The dev form is not on that list, and a plugin that imported it by hand would fail to load.
- **JSX only, not TypeScript.** Types in `client.js` are a syntax error, the same as before.

A file that will not parse is not served as a blank module. The route answers `422` with the file, the line and the reason, and the plugin keeps its place in Settings › Plugins carrying that message on its row — so a typo shows up as something to fix rather than as a plugin that vanished.

```jsx
import { AREAS, Card, CardContent, CardHeader, CardTitle, React } from '@jinn/plugin-sdk'

function InboxPage() {
  const [count] = React.useState(0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Inbox</CardTitle>
      </CardHeader>
      <CardContent>{count} messages waiting</CardContent>
    </Card>
  )
}

export default {
  id: 'inbox-demo',
  name: 'Inbox',
  register(ctx) {
    ctx.contributeMany([
      { id: 'page', area: AREAS.routes, data: { path: '/inbox' }, render: () => <InboxPage /> },
      { id: 'nav', area: AREAS.sidebarNav, data: { href: '/inbox', label: 'Inbox' } },
    ])
  },
}
```

### Calling the runtime by hand

The form JSX compiles to is still first-class, and a file written this way takes the byte-for-byte path — no compile, and nothing between your file and the browser. `jsx`, `jsxs`, and `Fragment` are re-exported from `@jinn/plugin-sdk` for it: `jsx(type, props)` for an element with zero or one child, `jsxs(type, props)` when `props.children` is an array, and `Fragment` when you need to return siblings without a wrapper element.

```js
import { AREAS, Card, CardContent, CardHeader, CardTitle, React, jsx, jsxs } from '@jinn/plugin-sdk'

function InboxPage() {
  const [count, setCount] = React.useState(0)

  return jsxs(Card, {
    children: [
      jsx(CardHeader, { children: jsx(CardTitle, { children: 'Inbox' }) }),
      jsx(CardContent, { children: `${count} messages waiting` }),
    ],
  })
}

export default {
  id: 'inbox-demo',
  name: 'Inbox',
  register(ctx) {
    ctx.contributeMany([
      { id: 'page', area: AREAS.routes, data: { path: '/inbox' }, render: () => jsx(InboxPage, {}) },
      { id: 'nav', area: AREAS.sidebarNav, data: { href: '/inbox', label: 'Inbox' } },
    ])
  },
}
```

`React.createElement` works too and is equivalent. The compiler sits on the serving path rather than in the plugin directory precisely so this stays true: a single file dropped in a directory still runs, and a file that needed no compiling is still handed over exactly as it was written.

The default export is checked field by field before anything is registered. `id` must be a non-empty string, `register` must be a function, and `name` must be a string when present. Anything else is rejected with a `PluginLoadError` naming the directory, which is logged rather than passing as a silent no-op; the plugin simply never registers.

---

## The SDK surface

`@jinn/plugin-sdk` is the app's own live namespace, not a copy that happens to look alike. That matters most for React: a plugin that resolved a second React instance would get a second dispatcher, and every hook it called would throw. The loader installs the running instances on globals and rewrites the plugin's import specifiers to small shim modules that read them back, so the bundled path and the disk path land on the same objects.

What the module exports:

- **React and the jsx runtime.** `React`, `jsx`, `jsxs`, `Fragment`.
- **UI primitives.** `Badge`, `Button`, `Card` and its parts, `Dialog` and its parts, `DropdownMenu` and its parts, `Input`, `ScrollArea`, `Select` and its parts, `Skeleton`, `Switch`, `Tabs` and its parts, `Textarea`, `Tooltip` and its parts, plus `cn` for merging Tailwind classes.
- **Icons.** `Icon`, which takes a `name` out of the app's curated set rather than a component, because a plugin cannot import an icon library. `IconName` is the union of names it accepts; an unknown one renders nothing and says so on the console.
- **The query client.** `queryClient`, the app's single instance with its cache and defaults already set.
- **Areas.** `AREAS`, the ids a contribution may target.
- **Route parameters.** `useRouteParams()`, what the current contributed page's path captured.
- **The host.** `host`, plus the `PluginSdkError` and `PluginHostDeniedError` classes so a plugin can tell an SDK failure from one of its own.
- **The contract version.** `SDK_CONTRACT_VERSION`, so a plugin can refuse to load against a contract it predates.

`host.notify` takes either a line of text with an optional level, or a `HostNotice` — `{ title, description?, level? }` — for a title with the detail under it. Both land on the same notice stack the app raises its own on, and both are dismissible; there is no second toast surface to learn.

The `host` object is three tiers of increasing authority: `host.state` (readonly snapshot of the active session and gateway status, with a `subscribe` shaped for `useSyncExternalStore`), curated actions (`host.navigate`, `host.notify`, `host.onEvent`), and the typed verb door below. Every verb is named and individually deniable later; v1 grants all of them. The verbs are typed rather than a generic `request(method, params)` for one reason: an untyped door cannot be narrowed afterwards without breaking every plugin at once. Nothing on `host` takes a method name or a path as an argument, which is what keeps that true.

#### The host verbs

Sixteen verbs, spelled identically on both halves — `PLUGIN_HOST_VERBS` in `packages/web/src/plugins/sdk/host-permissions.ts` and in `packages/jinn/src/plugins/host/permissions.ts`, and a test fails if the two drift. The client half is one `authFetch` per verb against a route the dashboard already calls; the server half is the same verb over the gateway's own in-process functions.

| Verb | R/W | Shape |
|---|---|---|
| `todos.list` | R | `(filter?: HostTodoFilter) → HostTodo[]` |
| `todos.create` | W | `(draft: HostTodoDraft) → HostTodo` |
| `todos.comment` | W | `(todoId, body) → HostTodoComment` |
| `sessions.spawn` | W | `(request: HostSessionSpawn) → HostSession` |
| `employees.list` | R | `() → HostEmployee[]` |
| `notify` | W | `(message, level?) → void` or `(notice: HostNotice) → void` |
| `notes.list` | R | `(query?) → HostNote[]` |
| `notes.read` | R | `(notePath) → HostNoteContent` |
| `notes.create` | W | `(draft: HostNoteDraft) → HostNoteContent` |
| `connectors.send` | W | `(connector, message: HostConnectorMessage) → void` |
| `cron.jobs` | R | `() → HostCronJob[]` |
| `cron.runs` | R | `(jobId, limit?) → HostCronRun[]` |
| `knowledge.search` | R | `(query) → HostKnowledgeResult[]` |

Cron is read-only by design: there is no verb that creates, edits, deletes, or fires a job. `HostCronJob` also withholds the job's prompt, model, and delivery target, exactly as `GET /api/cron` does — a plugin that can list jobs is not thereby able to read what they say. `HostCronRun` goes through the gateway's own run summariser, so a run log's prompt, output, and error text stay out of a plugin's hands too.

Failures are rejections, never a value a caller has to narrow. In the browser a refused request raises `PluginSdkError` carrying the gateway's own message; in the gateway a verb that could not act raises `PluginHostError` carrying the `verb` and the underlying reason code. A verb refused by the permission gate raises `PluginHostDeniedError` on both halves, which carries `verb` as well, so one catch reads both.

The `AREAS` values are the contract, and the property names are only an ergonomic alias:

| Constant | Value | Insertion point |
|----------|-------|-----------------|
| `AREAS.routes` | `routes` | A full page at `data.path`, rendered by `render` |
| `AREAS.sidebarNav` | `sidebar.nav` | A nav row (`data: { href, label, icon? }`, `icon` an `IconName`), visible on desktop, mobile, and overflow |
| `AREAS.statusBarRight` | `statusbar.right` | A chip in the status bar, at its right edge |
| `AREAS.todoDetailActions` | `todo.detail.actions` | A chip in the Todo detail crumb bar's right-hand action group, ahead of copy-link and ⋯ |
| `AREAS.todoDetailSections` | `todo.detail.sections` | A section in the Todo detail body, after the app's own sections and before the properties rail and Activity |
| `AREAS.chatComposer` | `chat.composer` | A chip in the chat view, in a row directly above the composer |
| `AREAS.homeWidgets` | `home.widgets` | A pane on the home surface — the chat sidebar, below its control band and above the chats — on both the desktop rail and the phone's home screen |

Every one of them is hosted, and every one behaves the same way in the two respects that matter when more than one plugin is installed:

- **Order is `order` ascending, and a tie keeps registration order.** A contribution without an `order` sorts as `0`. Two plugins that both omit it therefore land in load order, which is the order the directory was scanned in — pick an explicit `order` if the relative position matters to you.
- **Each contribution renders inside its own error boundary.** One that throws degrades to a Retry in its own slot, naming itself; its siblings, the surface hosting them, and the app keep working. Retry re-mounts it, so a failure that has since gone away recovers without a page reload.

`chat.composer` is composer-adjacent rather than in the message list because the composer is mounted for every chat view, the CLI one included, while the message list's footer is already occupied and mounts conditionally. A contribution's visibility should not depend on host state a plugin cannot see.

There is no dashboard route to host a widget on: `/` is the chat page, so `home.widgets` is hosted on the chat sidebar, which is the app's home surface on both form factors.

`icon` on a `sidebar.nav` row is an optional `IconName` — the same curated names accepted by `Icon` — because the loader's import allowlist does not reach an icon library. A row without one, or with an unknown runtime value, gets the app's fallback glyph.

### What a `routes` path may say

`data.path` is an absolute path of one or more segments. A segment is either a literal or `:name`, which captures whatever the URL has in that position — so a plugin can register `/inbox`, `/inbox/settings` and `/inbox/:messageId` and have all three resolve. Parameter names are letters, digits and underscores, starting with a letter or an underscore, and no name may appear twice in one path.

**The first segment must be a literal.** A path starting with a parameter would capture every URL the app does not claim, which is a plugin sitting in front of the whole app rather than owning a corner of it.

**Where two of a plugin's paths both fit a URL, the more specific one wins.** At `/inbox/settings`, `/inbox/settings` is served and `/inbox/:messageId` is not: the first segment where two matching paths differ decides, and a literal beats a capture. Paths of equal specificity go to whichever registered first, so a second plugin claiming a taken path cannot displace it.

**A plugin route can never shadow one of the app's.** The first segment may not be one of the app's own — `/settings`, `/settings/plugins` and `/todos/:id` are all rejected, because `/settings` and `/todos` are the app's. That is the rule said twice on purpose: the contributed host is mounted last, on the splat, so the router matches every app route before it in any case, and the check exists to say *why* a contribution never rendered instead of leaving its author to guess.

A path that breaks any of these is dropped with the reason on the console rather than served, and so is a contribution with no `render()`.

Inside the page, `useRouteParams()` returns what the path captured, keyed by the names it declared — `{ messageId: '42' }` at `/inbox/42`. The host parses the URL and hands the result down, so a page never reads `window.location` and never has to know the grammar. Outside a contributed route it returns an empty object.

### Only three specifiers resolve

A disk plugin may import `@jinn/plugin-sdk`, `react`, and `react/jsx-runtime`, and nothing else. Relative paths and full URLs resolve normally against the plugin's own module, but any other bare specifier is rejected **before evaluation**, with a named `PluginLoadError` that lists the offending specifiers and the three that are allowed. Failing up front is the point: the alternative is a cryptic native "Failed to resolve module specifier" arriving from inside a blob import, after the module has already started running.

The rewrite is anchored to import and export syntax and runs over a comment-masked copy of the source, so a string literal that merely reads `'react'` is never touched.

---

## Lifecycle

**Discovery.** The gateway creates `~/.jinn/plugins/` if it is absent and scans it, reading one manifest per directory (symlinked directories included). Absent is zero plugins, not an error. Every directory produces an inventory row, `{ id, name, version, kind, status }` plus `error` when something is wrong, where `kind` is `client` or `client+server`. Concurrent callers share one in-flight scan, so an inventory is never assembled from two different moments.

**Enable.** Discovery says what exists. `config.yaml` says what runs. See the next section.

**Mount.** For each enabled plugin the dashboard fetches `GET /api/plugins/<id>/client`, rewrites the SDK specifiers, evaluates the source as a module, validates the default export, and calls `register(ctx)` once. The context it passes is scoped by construction:

```js
register(ctx) {
  ctx.source                       // 'plugin:<id>', stamped by the host, not writable
  ctx.contribute(contribution)     // returns a disposer; ids are namespaced for you
  ctx.contributeMany([...])        // one disposer for the whole batch
  ctx.onDispose(fn)                // clean up a timer or subscription on unload
  ctx.storage.get(key, fallback)   // JSON persistence under jinn.plugin.<id>.
  ctx.storage.set(key, value)
  ctx.backend('/items')            // fetch against this plugin's own mount
  ctx.events(handler, options)     // this plugin's own event stream
}
```

Nothing on that context takes a plugin id, which is what makes the scoping true rather than merely stated: `ctx.backend` builds `/api/plugins/<own-id><suffix>` and throws on a `..` segment (encoded or not) instead of quietly rewriting it, `ctx.storage` keys are prefixed, and `ctx.events` subscribes to `/api/plugins/<own-id>/events` and cannot be pointed at another plugin's stream. There is no way to spell someone else's namespace.

`ctx.events(handler, options?)` returns an unsubscribe function, and hands `handler` each event the plugin's own backend passed to `ctx.emit`. The gateway keeps the last 200 events per plugin in memory with a monotonically increasing cursor, so a subscriber gets a replay of what the ring still holds and then live appends, and a reader whose cursor predates the oldest survivor is told it has a gap rather than handed a silent one. Pass `{ since }` to start from a cursor you already hold. The unsubscribe is tracked for you, so a reload closes the socket with the rest of the incarnation; returning it from a React effect is still the right thing, because that is what ends the subscription when the component goes away rather than when the plugin does.

**Watcher supervision.** If `server.js` exports a `watcher`, the gateway owns it end to end. Importing a module never starts anything: the supervisor calls `start(ctx)` on enable and on gateway boot, and `stop()` on disable, on reload, and on shutdown. The promise `start` returns is treated as the watcher's lifetime rather than its setup, so a task that fails an hour in is a crash the supervisor sees. A crash is retried with exponential backoff from 1 second, doubling each time, **capped at 5 restarts**; past that the watcher stays down and its health says so, because a background task that silently gave up is worse than one that is visibly dead. The restart count is never reset on a good run, so a watcher that crashes and recovers forever still reaches the cap and becomes visible. `stop()` gets 5 seconds before the gateway stops waiting on it, logs, and moves on: shutdown has to finish whether or not a plugin cooperates.

**Hot reload.** The gateway watches the plugins directory (skipping `node_modules` and `.git`) and rescans on a debounce. A saved edit to `client.js` disposes the previous incarnation first, running every disposer the old `register` accumulated, and only then evaluates and registers the new one; registering first would leave stale disposers holding entries the new registration had already replaced. On the gateway side, `server.js` is re-imported with a cache-busting query keyed on the file's size and mtime plus a generation counter, so an edit, or a disable followed by a re-enable, produces a genuinely new module rather than the incarnation the operator just turned off. The watcher is restarted against that same incarnation, so the background task and the routes are never two different copies of one plugin.

Editing `plugin.json` to change the id is handled too: the loader tracks which id each directory last loaded under, and disposes the previous one so its contributions do not orphan.

---

## Enable and disable

```yaml
plugins:
  enabled: [inbox-demo]
  disabled: []
  settings:
    inbox-demo:
      inboxDir: ~/inbox-drop
```

**Absence is not enabled.** The two lists are the operator's explicit decisions and the only input to the decision: a plugin named in neither is off. A plugin directory can arrive in an instance home by being copied, and it must not start running because nobody has said no to it yet. `disabled` wins over `enabled` when a plugin somehow appears in both, since the fail-closed reading is the safe one. A mistyped `plugins.enabled` that is not a list names nobody rather than enabling everything.

**A plugin cannot opt itself in.** Nothing a plugin ships declares whether it runs — there is no such field in the manifest and none in `client.js`, so `config.yaml` is the only input and the loader has nothing to ignore because there is nothing to declare. A field that flipped an unlisted plugin on would be the plugin making the operator's decision for them.

One policy, three enforcement points, each closing a different window:

| Point | What it stops |
|-------|---------------|
| Discovery and mount | A disabled plugin's `server.js` is never imported. Import is execution, so gating any later is gating after the code has run. |
| Every request | A plugin disabled while the gateway is running has routes already mounted. The per-request check is what makes a live toggle real. |
| Asset and client serving | `/client` and `/assets/*` both 404 for a disabled plugin, so a stale dashboard tab cannot resurrect it by reloading the module. |

`config.yaml` is watched, so a decision takes effect without a restart: disabling a plugin disposes its backend and stops its watcher on the config reload rather than waiting for a request that may never come.

`plugins.settings.<id>` is that plugin's slice of configuration, reachable as `ctx.settings` on the server context. It is read through a getter rather than captured at import time, so editing `config.yaml` reaches a registrar that loaded before the edit.

### Settings, Plugins

The dashboard page at **`/settings/plugins`** is the same policy with a UI on it. It lists every discovered plugin, enabled, disabled, and broken alike, with its version, kind, status, and load error where there is one. Toggling a plugin writes `config.yaml`, which is the same edit you would have made by hand and takes effect the same way. The page also reveals a plugin's folder, and offers an explicit rescan for the case where the directory cannot be watched and the automatic pass will not fire.

---

## The server half

`server.js` default-exports a registrar that receives the plugin's server context and returns a route map. Keys are `"METHOD /path"`, values are handlers taking the gateway's own `req` and `res`.

```js
export default function register(ctx) {
  return {
    'GET /items': async (req, res) => {
      const items = ctx.storage.get('items') ?? []
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(items))
    },
  }
}

let timer = null

export const watcher = {
  start(ctx) {
    timer = setInterval(() => {
      ctx.log('polling')
      ctx.emit({ type: 'tick', at: new Date().toISOString() })
    }, 30_000)
  },
  stop() {
    clearInterval(timer)
    timer = null
  },
}
```

The context carries `id`, `log`, `storage` (SQLite-backed and namespaced to the plugin, no id argument anywhere in the interface), `host` (the same sixteen typed verbs the client half gets, over in-process calls rather than HTTP), `emit`, and `settings`. `emit` refuses a value that is not JSON-serializable at the call site, so the failure lands on the plugin's own line rather than later inside a send it cannot see. A malformed `watcher` export is a load failure rather than a background task nobody supervises.

Everything under `/api/plugins/<id>/` reaches your routes except `client`, `assets/*`, and `events`, which belong to the gateway and are matched first so a plugin cannot register over them. Every call into plugin code, the registrar and the handlers both, is wrapped: a throw becomes a 500 with the gateway's own wording, and the plugin's error text and stack stay in the log rather than going out on the wire. A registrar that throws is cached as a failure, so a broken plugin is not re-imported on every request until its author fixes it.

---

## Security posture

**This is error isolation. It is explicitly not a capability boundary.**

A loaded `client.js` is evaluated as ESM in the dashboard's own realm, with the app's full authority: the React singleton, the whole SDK, the host verbs, and the gateway token the dashboard already holds. A loaded `server.js` is imported into the gateway process and can do anything the gateway can do, including reaching the filesystem, the network, and the company database. The per-contribution error boundaries, the per-listener try/catch, and the watcher supervisor stop a plugin from *crashing* Jinn. Not one of them stops a plugin from *acting as* Jinn.

The namespacing is real and worth having, and it is not a security control either. `ctx.storage`, `ctx.backend`, and `ctx.events` take no plugin id, so a plugin cannot *accidentally* reach another's namespace through the SDK, and `source` is stamped by the host so a contribution cannot claim provenance it does not have. A plugin that wants to bypass all of it can simply call `fetch` directly, because it is ordinary code in the page.

That posture is acceptable for exactly one threat model: plugins are local directories that the operator placed in their own instance home, and a local file on that machine can already run code. **Install a plugin the way you would run a shell script somebody sent you.** Read it first, or trust whoever wrote it. Loading plugins from a remote source is a non-goal rather than a later feature of this pipeline, because a real boundary means an iframe or a worker, a content security policy, and capability gating, which is a different pipeline and not a flag on this one.

Several guards do exist, and they are worth knowing because they shape what a plugin can be:

- **The plugins API lives under `/api/`**, so the gateway's single auth gate covers it. The enable check runs strictly after auth, which is what stops an unauthenticated caller from walking `/api/plugins/<guess>/` and reading installed-versus-not off the status code. An unknown id and a disabled one get the same 404.
- **Assets are served from `<plugin>/assets/` only**, never from the plugin root, and only with the suffixes `.js`, `.mjs`, `.css`, `.json`, `.svg`, `.png`, and `.woff2`. Anything else is a 404 rather than a 403, so the answer does not confirm the file exists. This keeps a dropped `.env`, a key, or an editor backup in a plugin folder from being handed out.
- **`server.js` is addressable by neither route.** The assets root sits below it, and `/client` resolves to exactly one manifest-named file that discovery has already proven is not the server entry.
- **Manifest paths are attacker-influenced input** and are treated as such: no absolute paths, containment checked on resolved real paths, and re-checked at mount.

---

## Gotchas

**Do not put a watched directory inside the plugins directory.** This is the one that catches everybody. The gateway watches `~/.jinn/plugins/` recursively, and *any* write under it triggers a rescan and a plugin reload. A file-drop inbox at `~/.jinn/plugins/inbox-demo/inbox/` therefore reloads the plugin every time a file lands in it, which at best is wasted work and at worst is a loop where the reload's own bookkeeping writes another file. Put the directory somewhere else entirely and point at it from `plugins.settings.<id>`, the way the `inboxDir` example above does. The only paths excluded from the watch are `node_modules` and `.git`, and that list is not for application data.

**`when()` is not reactive.** A contribution's visibility predicate is evaluated when its area's snapshot is rebuilt, which happens on a register or a removal *in that area*, not when your external state changes. If visibility has to follow live state, contribute unconditionally and render a component that returns `null`.

**A plugin id is permanent-ish.** It is the folder name, the `plugin:<id>` contribution source, the storage prefix, and the route mount. Renaming it is a new plugin as far as stored settings and `config.yaml` are concerned.

**Hot reload leaks module instances, by design.** Each generation of `server.js` is imported under a new specifier, and ESM offers no way to evict the old one from Node's module cache. That is the accepted cost of reloading without a restart. If a plugin holds something heavy, restart the gateway after a long editing session.

**A plugin that fails to load still has a row.** Look at `/settings/plugins` for the error text before assuming the directory was not found. The row is named for the folder when the plugin was too broken to have an id.
