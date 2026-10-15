# OpenCode 2 plugins for a Marid host

Two opencode plugins for hosts that run OpenCode 2 (2.0.28 or later). Both are
plain ES modules with no dependencies, because OpenCode 2 supplies
`@opencode/plugin` to plugins at runtime. Each one default-exports a
definition `{ id, setup }`, which is the only shape the 2.x loader accepts.
Plugins written for opencode 1.x (a `Plugin` factory) fail to load on 2.x with
`Plugin must export a default definition with an id and an effect or setup
function`. The server still starts, but without them.

| File | Replaces (1.x) | What it does |
|---|---|---|
| `error-retry.js` | a 1.x `error-retry.js` built on `auth.loader` | Retries a pre-stream HTTP 400 whose body is exactly `{"model":"<id>"}` in place, up to `maxRetries` times with exponential backoff. It acts on one provider (`providerID`, default `opencode-go`). The step never fails, so Marid's turn only sees it take longer. Any other 400, and every other status, is left alone. |
| `model-fallback.js` | `opencode-rate-limit@1.4.0` | On a rate-limit or quota error, it switches the session to the next usable model in `fallbackModels`, and opencode's own retry then runs on that model. It reads the same `rate-limit-fallback.json`: `fallbackModels`, `fallbackMode` (`stop` / `cycle` / `retry-last`), `cooldownMs`, `retryPolicy`, `circuitBreaker`. It switches the session back to its model when the execution ends, and adds a `/rate-limit-status` command. It does not carry over 1.4.0's health tracking, metrics or statistics. |

## Fallback chains per model

`fallbackModels` in `rate-limit-fallback.json` takes either of two forms:

- **A list**, as `opencode-rate-limit` takes it. It is the fallback chain for every model.
- **An object**, giving each model the session starts on its own chain, keyed by `provider/model`. `"*"` is the chain for any model not named. With no `"*"`, an unnamed model gets opencode's own retries only. `[]` turns fallback off for that model, even when there is a `"*"`.

```json
{
  "fallbackMode": "stop",
  "fallbackModels": {
    "opencode-go/deepseek-v4.1-flash": [{ "providerID": "openrouter", "modelID": "deepseek/deepseek-v4.1-flash" }],
    "opencode-go/qwen3-coder": [{ "providerID": "openrouter", "modelID": "qwen/qwen3-coder" }],
    "*": [{ "providerID": "openrouter", "modelID": "deepseek/deepseek-v4.1-flash" }]
  }
}
```

The chain is the one for the model the session was on when the turn first hit a rate limit. If its fallback is rate-limited too, the plugin moves to the next model in that same chain, not to the fallback's own. The next turn picks its chain again, from the model it starts on. Cooldowns and the circuit breaker are kept per model, across all chains.

## How they behave on 2.x

- **Fallback happens inside the turn.** The plugin switches the session's model from opencode's `retry` hook. There is no abort and no re-sent prompt, which is what `opencode-rate-limit` does on 1.x. A client of the server sees these events, in order:
  - `session.model.selected`
  - `session.retry.scheduled`
  - `session.step.started` on the fallback model, under the same assistant message.
- **Retrying a provider response.** Use `ctx.session.hook("http.response", cb, { providerID })`, which may replace `input.response`. The 1.x `auth.loader` fetch wrapper no longer exists.
- **An interrupt does not abort a request a hook is holding.** Both plugins stop on `session.execution.{succeeded,failed,interrupted}` themselves.

## Install

```sh
cp error-retry.js model-fallback.js ~/.config/opencode/plugin/
```

- `~/.config/opencode/plugin/*.js` is still loaded on 2.x, and so is `plugins/<name>/index.js`.
- Remove `opencode-rate-limit@...` from the `plugin` list in `opencode.json(c)`.
- Delete `commands/rate-limit-status.md`; the fallback plugin registers that command itself.
- `rate-limit-fallback.json` stays where it is (`~/.opencode/` or the config directory).

Check with `opencode plugin list` that both show as active. See
[`docs/opencode-2-upgrade.md`](../../docs/opencode-2-upgrade.md) for the whole
upgrade and the rollback.

Options can also come from the plugin entry's `options` in the config, or from
`error-retry.json` (same search path as `rate-limit-fallback.json`).
