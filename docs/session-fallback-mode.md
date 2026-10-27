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

opencode no longer falls back between models by itself: model and provider hops are gateway [fallback chains](fallback-chains.md), and an `auto-resume` session never moves along one. An opencode fallback plugin an operator installed is not under the gateway's control (it would switch models inside the engine even for an `auto-resume` session), so `jinn doctor`, the gateway's start-up log and `/api/engines` report it; see [opencode internal fallback is removed](fallback-chains.md#opencode-internal-fallback-is-removed).

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
  "target": { "engine": "codex", "model": "gpt-5.6-sol", "label": "gpt-5.6-sol" },
  "targetSource": "config",
  "allowedEngines": ["claude", "codex"]
}
```

- `modeSource` is `session` when the session has its own mode and `default` when it follows `sessions.fallbackMode`.
- `targetSource` is `session` when `target` is the session's own chosen fallback (see below) and `config` when it comes from the chains. `allowedEngines` lists the installed engines the session may choose as its own fallback: the same filters the substitute walk applies.
- `target` is where the session would fall back to, worked out from config alone: no engine health, and no check that a binary is installed. It is `null` when the chain is empty or has nothing the session may use. It is reported whatever the mode, so a client can decide what to show for `auto-resume`.
- `GET /api/fallback-preview?engine=&model=&employee=` answers `{ fallback }` with the view a new session with that selection would start with (the config's default mode, the chain's target, the engines it may pick), which is what the new-chat chip shows before any session exists. Department-scoped callers are refused it, as they are the chains endpoint.
- `label` is the model id when there is one, else the engine name. For another Claude account it is `claude:<account>`, followed by ` · <model>` when a model is resolved.

The target follows the same rules as the switch itself. A local Claude session walks its own account's chain. A department-scoped session takes only Claude-account entries (and a scoped session on another engine may only move to Claude). A remote session takes only engines that can also run on its host. The model is the session's model mapped through `fallbackModelMap` when the substitute serves it, else the substitute's configured or default model. A Claude account keeps the engine, and the session's model passes through that account's map.

## Choosing a fallback model for one session

By default a session falls back along the config's chain. The operator can instead name the engine and model one session switches to, so the choice does not depend on how the chain is configured.

- **Set it.** `PUT` or `PATCH /api/sessions/:id` with `{ "fallbackTarget": { "engine": "codex", "model": "gpt-5.6-sol" } }`; `{ "fallbackTarget": null }` clears it and the session follows the chain again. It is stored per session (`sessions.fallback_target`) and survives a restart. The request is refused with a reason when the engine is unknown or not installed, the model is not one the engine offers, the session is department-scoped and the engine is not claude, or the session runs on a remote host and the engine cannot run there. `POST /api/sessions` takes the same `fallbackTarget` (absent, or `null`, leaves the session on the chain, or on its parent's target when the parent passes it on) and refuses it with the same reasons, creating nothing. The web composer's fallback chip is on the new-chat screen too, where the choice rides on the create request, and it stays usable while a turn runs. Its menu has "Choose fallback model…" (the same engine, model and search picker as the new-chat selector, offering only the allowed engines) and "Use config fallback".
- **What a limit does.** In `fallback` and `fallback-children`, a usage limit switches the session to exactly that engine and model. It never uses the chain instead. When the chosen target cannot serve at that moment (the engine is not installed or not available to this session, has hit its own limit, no longer offers the model, or is the model that just hit its limit), the session parks and resumes when its own limit resets, as `auto-resume` does, and the notice and the session's last error say why. In `auto-resume` the target is kept but unused.
- **Same engine.** A target on the session's own engine (for example another Claude model) is a model change on the account the session is on. Engine health is not consulted for it, because a limit is recorded per engine and may have been the old model's alone.
- **Children.** A `fallback-children` session passes its target on with the mode, to children created by spawns, delegations and Talk delegations. Any other child gets no target. A child is checked against its own filters when the limit comes, so a target it may not use parks it.
- **MCP.** Not exposed through the MCP tools.

## Starting on a chosen profile

A session normally runs on its employee's Claude login (the default profile when the employee names none). It can instead be started on one of the declared accounts (`engines.claude.accounts.<name>`) by naming it in the `engine` field as `claude:<name>`, the spelling a chain entry already uses:

- **Where.** `POST /api/sessions` and `POST /api/delegations` take `"engine": "claude:friend"`; so do the MCP tools `spawn_session` and `delegate_task`, which pass the string through unchanged. The session runs the `claude` engine on that account. The choice is made at creation and never changed: `PATCH`/`PUT /api/sessions/:id` refuses an `engine` of that form with a 400. A bare engine name means what it always did, and a Todo's engine override outranks the request's engine, profile included.
- **Stored and reported.** The account's canonical directory is stored on the session (`sessions.claude_config_dir`, null when the session runs as its employee does). The session wire carries `claudeProfile: { name, key }` (`name` is null once config no longer declares the account), or null.
- **What follows it.** The session's own account is the chosen one wherever it used to be its employee's: the profile its turns spawn with, the account a usage limit is recorded against, the signed-in check, the thread slot, and the chain. A rate-limit swap onto another account still wins while its window stands, and when it ends the session returns to the chosen profile, not to the employee's. A chosen profile is a named target, so the session is never reordered at creation because another account is out of allowance.
- **Chain.** Precedence is unchanged (the session's own target, then its employee's `fallback`, then the account's chain, then the engine's). With no employee, or an employee without a `fallback`, the session inherits the chosen account's own chain, and the chosen account never appears in it as its own fallback.
- **Fork.** A duplicate of the session starts on the same profile, because its transcript lives there.
- **Preview.** `GET /api/fallback-preview?engine=claude:<name>` shows the chain such a session would get.
- **Refused.** An undeclared name is a 400 listing the declared ones; a remote employee is a 400 (it runs on its host's login); a department-scoped caller is a 403 (its department's separate allowance is not its to spend elsewhere). An operator may pick a profile for any local employee.

## MCP

`delegate_task` and `spawn_session` take an optional `fallbackMode` (`fallback`, `fallback-children` or `auto-resume`). Left out, the new session follows the inheritance rule above. A bad value is refused with a 400 that names the three.

When a delegation lands in a session the employee already has on the Todo, that session keeps its own mode, as it keeps its engine and model. If the delegation named a `fallbackMode` the session does not have, the response reports it under `selectionIgnored`.

Both tools also take `engine: "claude:<name>"` to start the session on a declared Claude account; see [Starting on a chosen profile](#starting-on-a-chosen-profile).
