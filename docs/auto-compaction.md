# Auto-compaction of cold sessions

Off by default. When it is on, Jinn compacts a long session **before** running its next turn if the session has sat idle past its engine's prompt-cache window.

## Why

An engine keeps a session's context in the provider's prompt cache for a short time after each request. Inside that window, a new turn re-reads the context at the cached price (about a tenth of the input price on Claude). Once the window has passed, the next turn pays full price to read the whole context again, plus the cost of writing it back into the cache. The turns after it then re-read all of it too.

For a long session that has gone cold, it is cheaper to compact first. The compaction reads the full context once, which the waiting turn was about to do anyway. The waiting turn and every turn after it then run on the summary.

The saving comes on the turns **after** the compaction, not on the compaction itself. A session that goes cold and then gets only one more short message saves little. A session that is picked back up for real work saves a lot.

## Configuration

Set it per engine, in `~/.jinn/config.yaml`. Only `claude` and `opencode` support it; putting the block on another engine is a config error.

```yaml
engines:
  claude:
    autoCompact:
      enabled: true              # default false
      cacheWindowSeconds: 300    # default 300
      minContextTokens: 100000   # default 100000
  opencode:
    mode: server                 # opencode can only compact in server mode
    autoCompact:
      enabled: true
      cacheWindowSeconds: 300
      minContextTokens: 100000
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Only the literal `true` turns it on. |
| `cacheWindowSeconds` | `300` | How long after the engine's last activity its cache is treated as cold. At least 1. |
| `minContextTokens` | `100000` | Sessions whose last turn read fewer tokens than this are never compacted. At least 1000. |

Picking `cacheWindowSeconds`:

- **Claude**: the prompt cache lasts 5 minutes by default (`300`). If your Claude Code requests the 1-hour cache tier, use `3600`. A window shorter than the real cache TTL wastes compactions on sessions that were still warm. A longer one misses some cold ones.
- **opencode**: set it to your provider's cache lifetime. `300` is a conservative guess. opencode in `run` mode has no compaction Jinn can call, so the setting does nothing there.

The config is validated when it loads and when it is saved from the dashboard. A quoted number, a negative value, an unknown key, or the block on an engine that cannot compact are all reported as errors.

## When it fires

A turn compacts first only when all of these are true:

1. `autoCompact.enabled` is `true` for the session's engine, and the engine can compact (Claude, or opencode in server mode).
2. The turn is not a compaction itself: an operator's `/compact`, or a session's own `compact_session`. It is also not another native command such as `/clear`.
3. The session already has a conversation on this engine, and has no engine switch pending. After a switch, the engine's own conversation is behind the chat, so there is nothing sensible to compact.
4. The context meter, which is the input size of the session's last turn as the engine reported it, is at least `minContextTokens`. An unread meter never counts as "long".
5. The engine's last activity on this conversation is at least `cacheWindowSeconds` ago. "Last activity" is the latest turn Jinn completed on it or, for Claude, the latest turn typed straight into its terminal that Jinn has synced. With no record of activity, the session is not treated as cold.

If any one of these is false, the turn runs exactly as it would without the feature.

## Where it runs

Inside the turn it precedes, between the turn's preflight and its engine run. Every transport reaches an engine through the same turn runner, so it applies the same way to the web chat, the CLI view's composer, connectors, cron jobs, and delegation callbacks.

Because it runs inside the turn:

- **Ordering is kept.** The turn already holds the session's queue slot, so nothing can run between the compaction and the message it was for. A message that arrives meanwhile waits behind both.
- **It can't compact twice.** The decision is made once per turn. A confirmed compaction resets the context meter and marks the engine as just active, so the next turn cannot fire it again, even if the message's own turn then fails.
- **It is not a separate turn.** There is no extra receipt and no extra callback to a parent session. The turn it precedes reports as it always would. The compaction's cost is recorded in the session's spend ledger.

## What you see

- A live status line while it runs, for example `🗜️ Session idle 42m with 180k tokens of context (past its 5m cache window) — compacting it before the next message…`
- A notice when it's done: `🗜️ Auto-compacted this cold session before the next message (180k tokens → 9.0k tokens; idle 42m, past the 5m cache window).` opencode reports only the size before.
- If it didn't work: `⚠️ Auto-compaction of this cold session didn't complete (<reason>), so the next message runs on the full context.`

## Failure never drops the message

An error, a usage limit, an engine that never confirmed the compaction, or an exception is logged and shown as the notice above. The message then runs on the full context as planned. A usage limit is left to the message's own turn, which takes the normal rate-limit path.

A failed compaction is not remembered: nothing is recorded against the session, so the next turn decides again from the same facts and tries once more. That includes a failed message after it. A turn that failed, for example on an expired login, leaves no mark of activity, so once the session can run again the next message still finds it cold and compacts it first.

The one exception is preemption. If the operator presses Stop, or something else interrupts the session, while it is compacting, the turn ends there, as it would have ended the engine run it was about to start.

A new operator message does **not** interrupt an auto-compaction in progress, even with `sessions.interruptOnNewMessage` on. It waits, as it waits for an operator's `/compact`: cutting the compaction off would waste it, and the next turn, still cold, would only start it again.

## What the compaction keeps

The compaction is the engine's own: Claude Code's `/compact`, or opencode's summarize. Claude gets a one-line focus that asks it to keep the task and its goal, decisions made and why, exact identifiers (Todo and session ids, branches, paths, PRs), work delegated and still awaited, and open problems. The focus also names any child sessions still running, since their results will arrive into the compacted context. opencode's summarize takes no focus.

There is no handoff here, unlike `compact_session`. The session did not choose the moment, so it had nothing to write. Agents are told this in the template `CLAUDE.md`: when they pause long work, they should leave its state somewhere a summary will keep it.

## Checking the saving

Each auto-compaction writes one line to `logs/gateway.log`:

```
[auto-compact] session=<id> engine=claude outcome=compacted idleSec=2520 windowSec=300 contextTokens=180000 preTokens=180000 postTokens=9000 costUsd=0.4210 durationMs=23015
```

`outcome` is one of `compacted`, `unconfirmed`, `failed`, `rate-limited`, `preempted` or `not-planned`. Outcomes other than `compacted` and `preempted` are logged at `warn` level with the error. `grep '\[auto-compact\]'` lists every compaction. Compare the session's spend before and after in the ledger (`jinn limits`, or `cost_report`) to see the effect. A session left alone is logged at `debug` level with the reason (`context-small`, `cache-warm`, …).

## Limits

- **Idleness is inferred, not read from the provider.** Nothing reports when a provider actually evicted a cache, so the window is a setting.
- **A turn that failed before filing its conversation doesn't count as activity.** The session can then look colder than it is and compact one turn early.
- **Claude turns typed into the terminal count once Jinn has synced them.** One typed moments before a message and not yet synced is missed.
- **The meter is the last turn's input size, not the next turn's.** A session with a huge prompt waiting but a short history is not compacted.
