# OpenCode 2 plugin for a Marid host

One opencode plugin for hosts that run OpenCode 2 (2.0.28 or later): a plain ES
module with no dependencies, because OpenCode 2 supplies `@opencode/plugin` to
plugins at runtime. It default-exports a definition `{ id, setup }`, which is
the only shape the 2.x loader accepts. Plugins written for opencode 1.x (a
`Plugin` factory) fail to load on 2.x with `Plugin must export a default
definition with an id and an effect or setup function`. The server still
starts, but without them.

| File | Replaces (1.x) | What it does |
|---|---|---|
| `error-retry.js` | a 1.x `error-retry.js` built on `auth.loader` | Retries a pre-stream HTTP 400 whose body is exactly `{"model":"<id>"}` in place, up to `maxRetries` times with exponential backoff. It acts on one provider (`providerID`, default `opencode-go`). The step never fails, so Marid's turn only sees it take longer. Any other 400, and every other status, is left alone. |

## Model fallback is not a plugin any more

opencode no longer switches models on a usage limit by itself. A usage limit
reaches the gateway as a rate-limit result, and the gateway moves the session
along its [fallback chain](../../docs/fallback-chains.md), which can cross
models, providers, engines and Claude profiles. There is no fallback plugin in
this directory. A host that still runs one (`opencode-rate-limit` on 1.x, or an
older copy of this directory's `model-fallback.js`) would fall back twice, so
`jinn doctor`, the gateway's start-up log and the opencode entry of
`/api/engines` report it. `jinn fallback migrate-opencode` prints the chain
equivalent to its `rate-limit-fallback.json`; see
[Migrating a host](../../docs/fallback-chains.md#migrating-a-host).

## How it behaves on 2.x

- **Retrying a provider response.** Use `ctx.session.hook("http.response", cb, { providerID })`, which may replace `input.response`. The 1.x `auth.loader` fetch wrapper no longer exists.
- **An interrupt does not abort a request a hook is holding.** The plugin stops on `session.execution.{succeeded,failed,interrupted}` itself.

## Install

```sh
cp error-retry.js ~/.config/opencode/plugin/
```

`~/.config/opencode/plugin/*.js` is still loaded on 2.x, and so is
`plugins/<name>/index.js`. Check with `opencode plugin list` that it shows as
active. See [`docs/opencode-2-upgrade.md`](../../docs/opencode-2-upgrade.md)
for the whole upgrade and the rollback.

Options can also come from the plugin entry's `options` in the config, or from
`error-retry.json` in the project's `.opencode/`, `~/.opencode/` or the
opencode config directory.
