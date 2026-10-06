# Auto-compaction of long sessions

Off by default. When it is on, Jinn compacts a long session **before** running its next turn if the session has sat idle past its engine's prompt-cache window. With a context budget set, it also compacts a session whose context has reached that budget, even if the session has not gone idle.

## Why

An engine keeps a session's context in the provider's prompt cache for a short time after each request. Inside that window, a new turn re-reads the context at the cached price (about a tenth of the input price on Claude). Once the window has passed, the next turn pays full price to read the whole context again, plus the cost of writing it back into the cache. The turns after it then re-read all of it too.

For a long session that has gone cold, it is cheaper to compact first. The compaction reads the full context once, which the waiting turn was about to do anyway. The waiting turn and every turn after it then run on the summary.

The saving comes on the turns **after** the compaction, not on the compaction itself. A session that goes cold and then gets only one more short message saves little. A session that is picked back up for real work saves a lot.

A session that keeps taking turns never goes cold, so the cache-window trigger never fires for it. The engine's own compaction then decides, and it waits for the model's context ceiling. opencode compacts at `limit.context − maxOutput`, which is about 968k tokens on a 1M-token model with the default 32k output. Its `compaction.reserved` setting does not lower that threshold unless the provider declares `limit.input`, and most do not. The context budget (`maxContextTokens`) is the threshold Jinn applies itself: once a session's context reaches it, the next turn compacts first, cache warm or not.

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
      maxContextTokens: 300000   # default: no budget
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Only the literal `true` turns it on. |
| `cacheWindowSeconds` | `300` | How long after the engine's last activity its cache is treated as cold. At least 1. |
| `minContextTokens` | `100000` | The cache-window trigger leaves sessions whose last turn read fewer tokens than this alone. At least 1000. |
| `maxContextTokens` | none | The context budget. A session whose last turn read at least this many tokens is compacted before its next turn, whether its cache is warm or cold. At least 1000. Unset, warm sessions are left to the engine's own compaction. |

Picking `maxContextTokens`: set it well above the size a session compacts down to. That size is the system prompt and tool definitions, plus the summary, plus whatever recent turns the engine keeps word for word. For a Jinn session on opencode that is often 50k–100k tokens. If the budget is below it, compaction cannot get the session under the budget. The hold described below then limits it to one compaction per quarter-budget of growth rather than one on every turn, but most of those compactions buy little.

Picking `cacheWindowSeconds`:

- **Claude**: the prompt cache lasts 5 minutes by default (`300`). If your Claude Code requests the 1-hour cache tier, use `3600`. A window shorter than the real cache TTL wastes compactions on sessions that were still warm. A longer one misses some cold ones.
- **opencode**: set it to your provider's cache lifetime. `300` is a conservative guess. opencode in `run` mode has no compaction Jinn can call, so the setting does nothing there.

The config is validated when it loads and when it is saved from the dashboard. A quoted number, a negative value, an unknown key, or the block on an engine that cannot compact are all reported as errors.

## When it fires

First, all of these must be true:

1. `autoCompact.enabled` is `true` for the session's engine, and the engine can compact (Claude, or opencode in server mode).
2. The turn is not a compaction itself: an operator's `/compact`, or a session's own `compact_session`. It is also not another native command such as `/clear`.
3. The session already has a conversation on this engine, and has no engine switch pending. After a switch, the engine's own conversation is behind the chat, so there is nothing sensible to compact.
4. The context meter has a reading. The meter is the input size of the session's last turn as the engine reported it. An unread meter never counts as "long".

Then the turn compacts first if either trigger applies.

**Cold cache.** Both of these are true:

- The meter is at least `minContextTokens`.
- The engine's last activity on this conversation is at least `cacheWindowSeconds` ago. "Last activity" is the latest turn Jinn completed on it or, for Claude, the latest turn typed straight into its terminal that Jinn has synced. With no record of activity, the session is not treated as cold.

**Context budget.** `maxContextTokens` is set, the meter is at least that, and the session is not on hold. `minContextTokens` and the cache window do not apply to this trigger.

Otherwise the turn runs exactly as it would without the feature. If both triggers apply, the compaction is reported as a cold-cache one.

### The budget hold

A compaction does not always get a session under its budget. The system prompt, the tool definitions and the turns the engine keeps verbatim may already add up to more, or a heavy turn may follow straight after. If the budget fired again on the next turn, it would compact on every turn and gain nothing. So an auto-compaction that leaves the session at or over the budget puts it on hold. The hold records the session's **floor**, the size it landed at:

- If the engine reported a size after the compaction, that size is the floor. Claude does this.
- If it did not, the next turn's reading is the floor. opencode does not report one.

A compaction that reports landing under the budget sets no hold.

While a session is on hold, the budget fires again only once the context reaches the higher of the budget and the floor, plus a quarter of the budget. With a 300k budget and a 310k floor, that is 385k. So growth always re-arms the budget, and a budget the session cannot get under costs at most one compaction per quarter-budget of growth.

Other readings also move the hold:

- **A reading under the budget lifts it.**
- **A lower reading that is still over the budget lowers the floor.** For example, an operator's `/compact` or the engine's own compaction brings a session held at 600k down to 320k. The floor becomes 320k, and the budget re-arms from there.
- **A different engine ignores it and clears it.** The hold applies only to the engine whose compaction set it. If the session switches engines, the next decided turn ignores it and clears it.

The hold never stops the cold-cache trigger. A skip while held is logged at `debug` level as `budget-held`.

A failed compaction sets no hold, so the next turn tries again. A duplicated session does not inherit its source's hold.

## Where it runs

Inside the turn it precedes, between the turn's preflight and its engine run. Every transport reaches an engine through the same turn runner, so it applies the same way to the web chat, the CLI view's composer, connectors, cron jobs, and delegation callbacks.

Because it runs inside the turn:

- **Ordering is kept.** The turn already holds the session's queue slot, so nothing can run between the compaction and the message it was for. A message that arrives meanwhile waits behind both.
- **It can't compact twice.** The decision is made once per turn. A confirmed compaction resets the context meter and marks the engine as just active. If it left the session at or over its budget, it also puts the session on hold. Either way the next turn cannot fire it again, even if the message's own turn then fails.
- **It is not a separate turn.** There is no extra receipt and no extra callback to a parent session. The turn it precedes reports as it always would. The compaction's cost is recorded in the session's spend ledger.

## What you see

- A live status line while it runs, for example `🗜️ Session idle 42m with 180k tokens of context (past its 5m cache window) — compacting it before the next message…`, or for the budget, `🗜️ Session at 320k tokens of context (past its budget of 300k tokens) — compacting it before the next message…`
- A notice when it's done: `🗜️ Auto-compacted this cold session before the next message (180k tokens → 9.0k tokens; idle 42m, past the 5m cache window).`, or `🗜️ Auto-compacted this session before the next message (it was 320k tokens; past its context budget of 300k tokens).` opencode reports only the size before.
- If it didn't work: `⚠️ Auto-compaction of this cold session didn't complete (<reason>), so the next message runs on the full context.` For the budget, the notice says "this session" instead of "this cold session".

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
[auto-compact] session=<id> engine=claude outcome=compacted trigger=cold idleSec=2520 windowSec=300 contextTokens=180000 preTokens=180000 postTokens=9000 costUsd=0.4210 durationMs=23015
[auto-compact] session=<id> engine=opencode outcome=compacted trigger=budget budgetTokens=300000 contextTokens=320000 preTokens=320000 postTokens= costUsd=0.0200 durationMs=41230
```

`outcome` is one of `compacted`, `unconfirmed`, `failed`, `rate-limited`, `preempted` or `not-planned`. Outcomes other than `compacted` and `preempted` are logged at `warn` level with the error. `grep '\[auto-compact\]'` lists every compaction. Compare the session's spend before and after in the ledger (`jinn limits`, or `cost_report`) to see the effect. A session left alone is logged at `debug` level with the reason (`context-small`, `cache-warm`, `budget-held`, …).

## Limits

- **Idleness is inferred, not read from the provider.** Nothing reports when a provider actually evicted a cache, so the window is a setting.
- **A turn that failed before filing its conversation doesn't count as activity.** The session can then look colder than it is and compact one turn early.
- **Claude turns typed into the terminal count once Jinn has synced them.** One typed moments before a message and not yet synced is missed.
- **The meter is the last turn's input size, not the next turn's.** A session with a huge prompt waiting but a short history is not compacted.
- **On opencode, a heavy turn straight after a compaction sets the floor.** opencode reports no size after compacting, so the floor is the reading at the end of the message turn the compaction ran in front of, and that includes the turn's own growth. If one turn takes a session from the compacted ~80k to 600k, the floor is 600k, and the budget waits until 675k. Claude reports the compacted size, so the same turn there is compacted on the next turn. The cost is bounded at a quarter of the budget past that reading, and it applies only when a single turn grows past the budget.
- **The budget is checked between turns, not during one.** A single long agentic turn can grow well past the budget. Jinn compacts before the turn after it. Within the turn, the engine's own compaction still applies at the model's ceiling. On opencode that compaction does fire in server mode below the raw context limit, at `limit.context − maxOutput` (`engines/__tests__/opencode-native-compaction-e2e.test.ts`).
