# Per-session fallback mode

When a session's model hits a usage limit, Marid can either switch the turn to a fallback engine or Claude account (set in `engines.<name>.fallback`), or park the session and retry it when the limit resets. The fallback mode chooses between the two for one session.

## The three modes

| Mode | At a usage limit | Children it creates |
|---|---|---|
| `fallback` | Switches to the configured fallback, as before this setting existed. | Get `auto-resume`. |
| `fallback-children` | As `fallback`. | Get `fallback-children`, so the setting passes down a whole tree. |
| `auto-resume` | Never switches model. The session waits and retries when the limit resets. | Get `auto-resume`. |

A session with no mode of its own follows the config default (below), which is `fallback`. Sessions that existed before this setting have no mode, so they behave as they always did.

## What `auto-resume` changes

- The turn is never handed to a substitute engine or account. It takes the same wait-and-retry path a board-walk turn does.
- A new session does not start on a fallback engine because its preferred engine is out of allowance. It starts where it prefers and waits.
- A stand-in from before (a substitute that was already running) is reverted at the next turn start. Changing the mode of a session does not move its engine by itself; the revert happens when its next turn begins.

In-engine fallback plugins that Marid does not control (for example an opencode rate-limit plugin) are out of scope: they switch models inside the engine, and the gateway cannot stop them.

## Where the mode comes from

The mode is stored on the session row when the session is created, and can be changed afterwards.

1. **Explicit.** `fallbackMode` on `POST /api/sessions`, on `POST /api/delegations`, or on the `spawn_session` / `delegate_task` MCP tools.
2. **Inherited.** A session created with a parent session (a spawn or a delegation by another session, or a Talk delegation) gets `fallback-children` if its parent's mode is `fallback-children`, and `auto-resume` otherwise. The parent's mode is its own, or the config default when it has none.
3. **Root.** A session with no parent stores no mode and follows the config default. So does a Talk hand-off: it is the root of its own work, like a new typed chat, even though the Talk session is recorded as its parent.
4. **Changed later.** `PUT` or `PATCH /api/sessions/:id` with `{ "fallbackMode": "<mode>" }`. It can be sent alone, and takes effect from the next usage limit, including one that arrives in a turn already running. `{ "fallbackMode": null }` clears the session's own mode, so it follows the config default again (`modeSource: "default"`). Create requests refuse `null`: leaving the field out already means the default.

**By default, the children of a `fallback` session stop falling back.** They get `auto-resume`, so only the root of a tree switches model. To restore tree-wide fallback for sessions that do not choose otherwise, set the default to `fallback-children`:

```yaml
sessions:
  fallbackMode: fallback-children   # fallback (default) | fallback-children | auto-resume
```

## What the API reports

`GET /api/sessions/:id` (the single session only, not the list) carries a `fallback` object, and so does the response to `PUT` / `PATCH`:

```json
{
  "mode": "fallback",
  "modeSource": "default",
  "target": { "engine": "codex", "model": "gpt-5.6-sol", "label": "gpt-5.6-sol" }
}
```

- `modeSource` is `session` when the session has its own mode and `default` when it follows `sessions.fallbackMode`.
- `target` is where the session would fall back to, worked out from config alone: no engine health, and no check that a binary is installed. It is `null` when the chain is empty or has nothing the session may use. It is reported whatever the mode, so a client can decide what to show for `auto-resume`.
- `label` is the model id when there is one, else the engine name. For another Claude account it is `claude:<account>`, followed by ` · <model>` when a model is resolved.

The target follows the same rules as the switch itself. A local Claude session walks its own account's chain. A department-scoped session takes only Claude-account entries (and a scoped session on another engine may only move to Claude). A remote session takes only engines that can also run on its host. The model is the session's model mapped through `fallbackModelMap` when the substitute serves it, else the substitute's configured or default model. A Claude account keeps the engine, and the session's model passes through that account's map.

## MCP

`delegate_task` and `spawn_session` take an optional `fallbackMode` (`fallback`, `fallback-children` or `auto-resume`). Left out, the new session follows the inheritance rule above. A bad value is refused with a 400 that names the three.

When a delegation lands in a session the employee already has on the Todo, that session keeps its own mode, as it keeps its engine and model. If the delegation named a `fallbackMode` the session does not have, the response reports it under `selectionIgnored`.
