# Research: Idle-Capacity Auto-Start

Each entry: the question, what was found (with where), and the decision it led to.

## R1. Is the Claude limits collector already callable outside the dashboard?

**Found**: yes, three ways before this feature. `collectClaudeLimits`
(`packages/jinn/src/shared/engine-limits-claude.ts:232`) is a plain async function; the CLI
runs it as `jinn limits --json --engine claude` (`cli/limits.ts:78`); the gateway serves it at
`GET /api/engine-limits` (`gateway/api.ts:4499`) and re-reads it every 15 minutes for the
health store (`gateway/background-refresh.ts:41`). Each window carries `resetsAt` (unix
seconds) and `resetsAtIso`.

**Decision**: nothing to expose. The loop calls the function.

## R2. Cron job or gateway loop?

**Found**: a Jinn cron job is a prompt run by an engine (`cron/runner.ts:42`). The decision
here is "is `used ≤ ceiling` and `minutesToReset ≤ lookahead`" — numeric. An LLM cron would
spend Claude capacity to decide whether Claude capacity is spare, on the window being measured,
and would be non-deterministic about a threshold.

**Decision**: a gateway timer (`gateway/idle-capacity.ts`), patterned on
`background-refresh.ts` (config read at fire time, unref'd). The word "cron" in the ticket is
the cadence, not the mechanism.

## R3. What does the account's reading look like right now?

**Found** (built CLI on the build host, 2026-09-20 ~08:30Z, plan `max`):

```
5h: 13% used, resets 2026-09-20T11:00Z
7d: 68% used, resets 2026-09-22T14:00Z
7d Fable: 0% used, resets 2026-09-22T14:00Z
```

The scoped weekly bucket is named `7d Fable` (`engine-limits-claude-usage.ts:17-22`). The
weekly all-model bucket sits close to the daytime ceiling of 75%.

**Decision**: every `7d*` bucket is held to the weekly ceiling (a start would most likely run
on the model a scoped bucket meters). The daytime weekly default of 75% is deliberately close
to the observed reading so the operator sees the ceiling bite on the preview before enabling.

## R4. Does the five-hour cadence need to be inferred? (operator open question 1)

**Found**: no. The reading names each window's actual reset time; the loop compares
`resetsAt - now` against a lookahead. No assumption about how many five-hour periods a week
holds, or when they start, exists anywhere.

**Decision**: closed; stated in the spec's Open Decisions as resolved.

## R5. What can "the operator has an active session" mean, precisely? (open question 2)

**Found**:

- Jinn's interactive Claude sessions (dashboard CLI mode, a PTY) install a statusline recorder
  (`shared/claude-settings.ts:43`) that writes `<session>.json` into `CLAUDE_LIMITS_DIR` on
  every turn; `engines/claude-interactive.ts:1259` is the only place that sets it, and
  `engines/remote-stage.ts:1250` deliberately does not for remote sessions. The newest file's
  mtime is the last moment the operator drove Claude from inside Jinn.
- The operator's own Claude Code sessions run on other machines; the gateway has no file or
  process to inspect. What it does have is the account reading, which includes that use.
- Jinn's own sessions are visible: `sessionsHoldingEngineCapacity` (`gateway/api.ts:1096`)
  and `lastActivity` on every session (`sessions/registry.ts:1112`).

**Decision**: three signals, any marks the operator seen, live for `idleMinutes` after:
(a) activity on an operator-driven session — top-level (`parentSessionId` null), source not
`cron`/`workflow` and no Workflow provenance, employee not a system employee — which is the
common case of the operator mid-conversation with the COO or an employee via the dashboard or
Telegram, turn finished, reading and typing (review round 2); (b) statusline snapshot mtime;
(c) five-hour used share rising by ≥ `usageDeltaPercent`
between two readings of the same window while no Jinn session was active in between — usage
the system did not spend is the operator's, wherever they spent it. False positives (a Jinn
session too brief to be caught between ticks) back the loop off, which is the safe direction.
A fourth candidate (gateway-host `~/.claude/projects` mtimes) was rejected as speculative: the
operator does not work on the gateway host.

## R6. Does OpenCode have a usage-limit signal to plumb?

**Found**: OpenCode resolves to whatever provider its config names; here
`~/.config/opencode/opencode.jsonc` → `opencode-go/deepseek-v4.1-flash`, with the
`opencode-rate-limit@1.4.0` plugin falling back to `openrouter/deepseek/deepseek-v4.1-flash`
(pay-per-token) on a 429. The plugin's README and dist contain no quota or usage endpoint: it
"intercepts standard HTTP status codes (like 429) to trigger the fallback". The OpenCode CLI
source in the cache references `https://opencode.ai/zen/go/v1` and `/zen/v1` as chat
endpoints only. A live authenticated probe of the Go API for a usage route was blocked by the
remote secrets hook and not attempted another way.

**Decision**: not applicable — there is no "unused before reset" reading. `jinn limits
--engine opencode` now says so (`shared/engine-limits.ts:301`).

## R7. What does a ceiling actually guarantee?

**Found** (review round 1): nothing bounds consumption after a start. A senior-developer Opus
session runs one to three hours; a start at T−120 min can carry the window past its ceiling
and into the next. The first draft's docstring and doc claimed otherwise.

**Decision**: the claims are corrected everywhere to "a gate on starting, re-checked each
tick"; the residual risk is stated in `docs/idle-capacity.md`; stop-on-ceiling is recorded as
Open Decision 1 for the operator. The per-window start cap and the next tick's ceiling check
are the bounds that do exist.

## R8. Can a started Todo end up spending another provider's money?

**Found** (review round 1): yes, two ways. A Todo's dispatch override can pin its next attempt
to `opencode` (`work-items/dispatch-config.ts`), which puts the Dispatcher itself on OpenCode;
and the Dispatcher's routing can pick an OpenCode employee (`junior-developer` in this org).

**Decision**: pinned Todos are skipped (FR-011); the Dispatcher's prompt carries the purpose
of the start and asks for a Claude-engine employee (FR-003); the remaining discretion is
recorded as Open Decision 2.
