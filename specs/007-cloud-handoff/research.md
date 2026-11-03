# Research: Cloud Handoff

**Feature**: [spec.md](./spec.md) · **Date**: 2026-11-03

This file records how Claude's cloud execution works today, what the gateway already has
that a handoff could build on, and what could not be confirmed. It comes before `plan.md`.

Two kinds of source are used, and each finding says which:

- **Docs**: Anthropic's published documentation, read on 2026-11-03. URLs are given per
  finding. Short names: **CW** = `code.claude.com/docs/en/claude-code-on-the-web`,
  **CE** = `.../cloud-environments`, **RT** = `.../routines`, **SH** =
  `.../self-hosted-environments`, **SHT** = `.../self-hosted-environments-testing`,
  **AUTH** = `.../authentication`, **FIRE** =
  `platform.claude.com/docs/en/api/claude-code/routines-fire`, **MA** =
  `platform.claude.com/docs/en/managed-agents/overview`.
- **CLI**: the Claude Code CLI's own `--help`, version 2.1.317.

Nothing in this research created, ran or changed a cloud session, routine or environment on
any account. Every claim about runtime behaviour beyond the docs is marked **UNVERIFIED**
and becomes a Phase 0 spike question in `tasks.md`.

## R1. What a cloud session is

- A cloud session is a Claude Code session on an isolated, Anthropic-managed VM. It keeps
  running after the client disconnects and can be steered from the web, the mobile app or
  the CLI (CW).
- It is billed to a claude.ai subscription. It "counts toward your plan's usage limits
  alongside the rest of your Claude and Claude Code usage, and there's no separate charge
  for the cloud VM" (CW). Plans: Pro, Max, Ultra, Team, and Enterprise with the right seats
  (CW).
- The VM clones the repository's **GitHub remote** at the current branch, not the local
  checkout (CW). Non-GitHub repositories can be uploaded as a bundle, but "the session
  can't push results back to that remote" (CW, Limitations).
- What loads inside it: the repository's `CLAUDE.md`, `.claude/settings.json` (hooks and
  permissions), `.mcp.json`, skills, agents and commands from the clone. User-level
  `~/.claude` config, user-scope MCP servers and repo-declared plugins do not load (CE).
  The account's claude.ai connectors can be attached (RT, CE).
- **Remote Control is a different thing.** It lets the web or mobile app steer a session
  that still runs on the local machine (CW: "`--remote-control` is unrelated"). It spends
  no cloud compute and is not a handoff mechanism.
- Self-hosted environments (`ccpool_...` ids) are a public beta on Team and Enterprise.
  The customer runs the compute on runners that poll Anthropic's queue, and Anthropic
  still hosts the queue, transcript and inference (SH).

## R2. How a session can be created, and from where

| Path | Programmatic? | Auth | Source |
| --- | --- | --- | --- |
| claude.ai/code, mobile, Desktop | No | claude.ai sign-in | CW |
| `claude --cloud "<task>"` (interactive) | Only by driving a terminal | claude.ai OAuth | CW |
| `claude -p "<task>" --cloud "<task>"` | **No: rejected.** "`--cloud` is rejected ... in non-interactive runs when it carries a description" | n/a | SHT |
| `claude -p "<task>" --environment <ccpool_id> --output-format json` | Yes. Prints `{"ok":true,"session_id":...,"url":...}` and exits | claude.ai OAuth | SHT (self-hosted only) |
| Routine fire: `POST https://api.anthropic.com/v1/claude_code/routines/{trig_...}/fire` | Yes. Returns `{claude_code_session_id, claude_code_session_url}` at creation | Per-routine bearer token, created in the web UI | FIRE |
| Claude Managed Agents `POST /v1/sessions` | Yes, a full API | Claude API key | MA (a different product, see R9) |

**Finding R2.1.** For Anthropic-hosted compute, the only documented unattended entry point
is the routine fire endpoint. It is marked experimental: "Request and response shapes, rate
limits, and token semantics might change" (FIRE).

**Finding R2.2 (UNVERIFIED).** The CLI help says `--environment` takes a self-hosted
environment (`ccpool_...`). Whether it also accepts an Anthropic-hosted environment id, which
would give an OAuth-authenticated headless create with a per-call repository and ref, is not
documented. Phase 0 spike, question S2.

## R3. Routines (scheduled tasks) and the fire endpoint

The docs now call routines "scheduled tasks", a research preview. This spec says "routine",
the name the API and its token still use.

- A routine pins a prompt, one or more repositories, an environment, a model and
  connectors. It runs as a cloud session on a schedule, on a GitHub event, or when its API
  trigger is fired (RT).
- **Only the web UI can create an API trigger and its token.** "You can't add an API
  trigger or manage its token from the CLI" (RT). "There is no public API for token
  management. Generating a new token revokes the previous one" (FIRE).
- The token is scoped to one routine: "it grants no read access, no access to other
  routines, and no access to account data" (FIRE). It does not expire on a 30-day cycle
  (contrast R6). **UNVERIFIED** whether it expires at all. The docs give no lifetime.
- The fire body is `{"text": "..."}`, freeform, at most 65,536 characters, "passed to the
  routine alongside its saved prompt" (FIRE). Per-fire variation is limited to this text:
  repository, environment, model and connectors are fixed by the routine.
- The text "arrives wrapped in a `<routine-fire-payload>` block that labels it as untrusted
  data". The routine's saved prompt has to opt in to acting on it (RT). The contract's saved
  prompt does this, and names the block.
- No idempotency key: "If a webhook caller retries, the endpoint creates multiple sessions"
  (FIRE).
- Limits: 30 fires per hour per routine (shared with **Run now**) and 100 API fires per
  hour per account, with `429` and `Retry-After` (FIRE).
- "The request returns once the session is created. It does not stream session output or
  wait for the session to complete" (FIRE).
- Connectors are on by default: "When you create a scheduled task, all of your currently
  connected connectors are included by default" (RT). They have to be removed from the
  routine by hand.
- **UNVERIFIED**: that connectors an organisation admin set up can still reach a run whose
  own list is empty. This comes from the CLI's routine tool description, not the public
  docs.
- Work is pushed "to a branch prefixed with `claude/` unless your prompt directs it to push
  to another branch" (RT). Commits and PRs appear under the routine owner's GitHub identity
  (RT).

## R4. Getting results back

- **There is no documented API to read, poll or stream an Anthropic-hosted cloud session.**
  The fire token has no read access (FIRE). Output arrives as a pushed branch, a diff in the
  web UI, a PR, and the transcript at claude.ai/code (CW).
- Follow-ups can be queued with `claude -p "msg" --cloud <session-id> --output-format json`,
  which prints `{ok, session_id, url}` and "exits without waiting for a reply" (CW). This
  needs a claude.ai OAuth login (R6).
- The documented read-back recipe is a `Stop` hook on a **self-hosted** runner that writes
  `last_assistant_message` to a file or URL (SHT). It does not apply to Anthropic-hosted
  sessions, where the operator does not control the runner.
- The Claude Code CLI ships a first-party tool for routines that calls endpoints under
  `/v1/code/...` with the user's OAuth token, including a per-run event log. **These are not
  published API documentation.** A third-party gateway must not depend on them (plan D3).
- GitHub inside the VM goes through a proxy that holds the credential. The proxy "rejects
  branch deletions and pushes of anything other than a branch", "doesn't limit which
  branches a push can update", and blocks GitHub GraphQL, so `gh pr` subcommands that use
  GraphQL fail and `gh api` REST is the fallback (CE). CE also says that "`gh api` calls for
  attached repositories work without a token of your own". So a routine run is **expected**
  to be able to open a PR through REST without the web UI's **Create PR** button. Phase 0
  confirms it (S3).

**Finding R4.1.** For an Anthropic-hosted session, the one result channel a gateway can
read without undocumented endpoints is GitHub: the branch, its commits and its PR. The
handoff contract (`contracts/handoff-brief.md`) is designed around that.

## R5. Lifecycle, cancellation and limits

- Idle: "after a few minutes without activity, a session's VM pauses with its files saved";
  a paused VM can later be reclaimed ("Environment expired"), and reopening restores the
  conversation but not background shells or subagents (CW, CE).
- A session that asks a question waits for an answer "up to environment expiry" (CW). From
  the gateway's side that is indistinguishable from a slow session.
- **No documented stop or cancel API.** Archive and delete exist in the web UI. Archived
  sessions reject new messages (CW).
- Command timeouts: Bash defaults to 2 minutes, up to 10, then backgrounded (CE).
- **UNVERIFIED**: the maximum wall-clock session length and the concurrency limit. The
  docs mention that an organisation can reach "its limit on cloud sessions running at
  once" but give no number (RT).
- Permission modes in cloud sessions are Auto, Accept edits and Plan. There is no Manual
  and no Bypass (CW).
- Routine runs start in auto mode. After repeated classifier blocks, "a permission prompt
  appears in the run's session and waits until someone answers it" (RT, "Permission prompts
  during a run"). GitHub cannot see that wait, and no instruction in the brief can prevent
  it. To the gateway it looks like a slow session that ends in a timeout.

## R6. Authentication

- `--cloud`, `--teleport` and follow-ups need a claude.ai OAuth sign-in. API keys and
  Console sign-ins fail with `Unable to get organization UUID` (CW).
- "There is no long-lived CI token for this today. The scope that grants cloud-session
  control, `user:sessions:claude_code`, is capped server-side at 30 days, so
  `claude setup-token`, which mints a one-year inference-only token, doesn't cover it"
  (SHT). A long-lived host must re-run `claude auth login` every 30 days (SHT).
- One `CLAUDE_CONFIG_DIR` per account gives each account its own login (AUTH), so the
  gateway's existing per-employee Claude profiles could each hold a login.
- The routine fire token (R3) is the exception: it is a per-routine bearer and is not bound
  to the 30-day OAuth refresh grant.

## R7. Billing, credits and metering

- Cloud sessions draw the **same** subscription usage limits as local Claude Code, and
  "running multiple tasks in parallel consumes more rate limits proportionately" (CW).
  Routines "draw down subscription usage the same way interactive sessions do" and, with
  extra usage on, continue as metered overage (RT).
- **The promotion that motivated this feature is time-limited.** The "Cloud sessions bonus
  credit promotion" gave individual Pro subscribers $100 and Max subscribers $250 of cloud
  credit. "Credits expire November 4 at 11:59 PM PT". It excludes Team and Enterprise,
  API-key, Bedrock and Vertex use, and **"Projects and Routines"**. After the credit runs
  out, "cloud sessions count toward your plan's usage limits"
  (`support.claude.com/en/articles/17152539-cloud-sessions-bonus-credit-promotion`).
- Consequence: after 2026-11-04 a cloud session buys **no extra model capacity** over a
  local session on the same account. A second account adds capacity, but the gateway can
  already use a second account locally through a Claude profile. What a cloud session
  still adds is compute and wall-clock off the build host, parallelism beyond the host's
  CPU, and work that survives the host going down.
- Even while it lasted, the promotion did not cover routines, and routines are the only
  documented unattended entry point (R2.1).
- No per-session cost or usage API exists for subscription cloud sessions. Usage shows on
  claude.ai's usage settings page (CW). **UNVERIFIED** whether the OAuth usage endpoint the
  gateway already reads for limits (`packages/jinn/src/shared/engine-limits-claude.ts:77`)
  reflects cloud-session usage in the same windows. Phase 0 question S5.

## R8. Security and data handling

- Each session is an isolated VM. Git credentials and signing keys stay outside it, behind
  the GitHub proxy (CW, CE).
- Network levels per environment: None, Trusted (default allowlist), Full or Custom. The
  Anthropic API is reachable even at None, "which may allow data to exit the VM" (CW, CE).
- Environment variables are readable by anyone who uses the environment. "Network secrets"
  are attached by Anthropic's proxy to requests for listed hosts and never enter the VM
  (CE).
- Retention (`code.claude.com/docs/en/data-usage`): Anthropic stores the transcript. On
  consumer plans that is 5 years if model improvement is allowed, otherwise 30 days.
  Commercial plans keep it 30 days. Deleting a session removes its event data.
- Organisations with Zero Data Retention, the HIPAA configuration, customer-managed keys or
  an IP allowlist cannot use Anthropic-hosted cloud sessions (CW).
- Session sharing can make a session, and any private-repository code in it, visible to
  others (CW).

## R9. Claude Managed Agents: the API-billed alternative

- Managed Agents is a full programmatic API: create sessions, send events, stream over SSE,
  interrupt, set budgets, attach a GitHub repository with a token the caller supplies (MA
  and its sessions, events and GitHub pages).
- It is billed to the Claude API, as tokens plus a per-session-hour runtime charge
  (`platform.claude.com/docs/en/about-claude/pricing`). It is not Claude Code and does not
  draw subscription usage or cloud credit.
- It is the right base for a true "cloud engine" if the motivation is ever API spend rather
  than subscription credit. It is out of scope here (spec, Out of scope).

## What already exists in the gateway (constitution Principle VII)

Verified against `origin/main` at `53e47059`. `src/` is `packages/jinn/src/`.

| `path:line` | What it is | Use here |
| --- | --- | --- |
| `src/shared/types.ts:110` | `Engine`: `name` plus one awaited `run(opts)` | The adapter is an `Engine` (plan D1) |
| `src/shared/types.ts:115` | `InterruptibleEngine`: `kill`, `isAlive`, `killAll`, `killIdle` | `kill` abandons a handoff; `isAlive` keeps the reconciler off a long wait |
| `src/shared/models.ts:61` | `ENGINE_NAMES`, the closed engine list | Does **not** gain `claude-cloud` (plan D9). `buildRegistry` builds an entry for every name in it, whatever the config says (`:447`) |
| `src/shared/models.ts:441` | `buildRegistry(config)`, the model registry | Gains a `claude-cloud` entry **only** when the block is enabled and valid. `ModelRegistry` is `Record<string, …>` (`src/shared/types.ts:804`) |
| `src/shared/models.ts:98` | `REMOTE_ENGINE_NAMES` | Does **not** gain it: a cloud session is not an ssh host |
| `src/gateway/server.ts:735` | The engine registry map, filled at `:739`–`:750` | Registers the adapter only when the feature is enabled |
| `src/mcp/delegation-tools.ts:108` | `delegate_task.engine` is a free `{ type: "string" }` | Selecting `claude-cloud` costs **zero** manifest tokens |
| `src/sessions/session-patch.ts:65` | `validateNewSessionSelection` refuses an engine with no **model-registry** entry, before anything is created | This is the off switch: no registry entry, so `unknown engine` at creation |
| `src/gateway/api.ts:4314` | `/api/engines` serves the model registry | Lists `claude-cloud` only when its entry exists |
| `src/work-items/dispatch-config.ts:212`, `:279` | A scoped department's dispatch override must be `claude`, at write time and again at dispatch | Scoped departments are refused the cloud with no new code |
| `src/sessions/turn/scoped-turn.ts:15` | `refuseScopedTurn`: scoped sessions run `claude` only | Same: the existing gate already refuses `claude-cloud` |
| `src/sessions/turn/engine-run.ts:45` | `plan.engine.run({...})`, the single engine call | The adapter needs nothing new in the turn pipeline |
| `src/sessions/callbacks.ts:112` | `notifyParentSessionAndWait`, the durable parent callback | A finished handoff reaches its parent through the existing path |
| `src/sessions/callbacks.ts:153` | `notifyParentOfExternalTurn`, for replies after a settle | **Not used.** It skips the delegation completion contract (`:146`–`:151`), so a result delivered through it would never re-judge the Todo |
| `src/sessions/turn/heartbeat.ts:5` | A 5 s heartbeat writes `lastActivity` while `run()` is pending | This is what keeps a waiting handoff `running` |
| `src/gateway/status-reconciler.ts:50` | The reconciler looks at liveness only once `lastActivity` is 45 s stale (`DEFAULT_STALE_MS`, `:21`) | `isAlive` is a backstop. The heartbeat is the main mechanism |
| `src/sessions/registry.ts:1662` | `recoverStaleSessions`: at boot, every `running` session is marked `interrupted` | A handoff's session goes through this like any other (plan D5) |
| `src/sessions/queue-item-registry.ts:216` | `recoverStaleQueueItems`: a `running` queue item is reset to `pending` and replayed | The replayed turn calls `run()` again with the original prompt. That replay is the re-attach (plan D5) |
| `src/work-items/attempt-evidence.ts:93` | `collectAttemptEvidence`: closes runs for settled attempts (`:98`), then builds the evidence the status derivation reads (`:103`) | Treats a session with an open handoff as in flight (plan D5, FR-017a) |
| `src/work-items/reconcile.ts:116` | With nothing in flight, an `interrupted` newest attempt derives `blocked` | Why boot would flap a handoff's Todo without FR-017a |
| `src/work-items/child-settles.ts:43` | A child Todo moving to `blocked` is a child settle, and wakes the parent's owner | The wake FR-017a prevents during a handoff |
| `src/sessions/restart-resume.ts:439` | Replaying sessions get no resume nudge, and others get one unless nudges are off (`:451`) | No skip list is needed: any turn on a session with an open handoff re-attaches |
| `src/work-items/runs.ts:171` | `closeWorkItemRun`, which carries `summary` and `handoff` | Production callers pass `outcome` only (`src/work-items/attempt-evidence.ts:55`). Phase 2 fills them |
| `src/gateway/budgets.ts:6` | `isBudgetExhausted`: per-employee monthly USD, checked before a turn | Cannot bound a handoff, whose cost reads $0. The feature carries count caps (FR-012) |
| `src/shared/env-ref.ts:17` | `resolveEnvVar`: `${VAR}` indirection for secrets in config | How the routine token and GitHub token are referenced |
| `src/shared/remote-mcp-config.ts:100` | `remoteMcpProblems`, a sibling `*-config.ts` validator for an off-by-default feature | The pattern for `cloud-handoff-config.ts` |
| `src/shared/config.ts:37` | `validateConfigShape`, where sibling validators are called | Hooks the new validator in |
| `src/gateway/remote-mcp/http.ts:217` | `/mcp` accepts only a Cloudflare Access assertion | A cloud session cannot reach the gateway's tools with a static token. Plan D4 keeps it that way |
| `src/shared/engine-limits-claude.ts:77` | The OAuth usage endpoint the Limits page reads | May already show cloud usage (S5) |

### Repository mentions

Nothing in the tree creates or reads Anthropic cloud sessions, routines or teleports. The
one mention is a 2026-05-14 engine design note
(`docs/superpowers/specs/2026-05-14-interactive-tui-engine-design.md`), which calls the CLI's
Remote Control bridge "Anthropic-cloud-gated and not locally addressable". "Remote session"
everywhere else means an ssh build host (`docs/remote-execution.md`).

## UNVERIFIED, carried into the Phase 0 spike

| Id | Question | Why it matters |
| --- | --- | --- |
| S1 | Does a routine run obey a branch name and a PR-body result block given in the fire `text`? | It is the whole result channel (R4.1) |
| S2 | Does `claude -p ... --environment <anthropic-hosted id> --output-format json` create an Anthropic-hosted session? | It would remove the per-routine web-UI setup, at the price of the 30-day login |
| S3 | Can a routine run open a draft PR through `gh api` REST, given the GraphQL block? Expected yes (R4, CE), but not yet confirmed | Without it the result has to live in a commit, not a PR |
| S4 | Does the routine fire token expire? | Decides whether the feature needs an expiry alarm |
| S5 | Does the existing OAuth usage reading include cloud-session usage? | Decides whether the Limits page and the rate-limit guard see handoffs |
| S6 | What happens when a run asks a question, or stops at a permission prompt (R5), and nobody answers: how long until the environment expires, and does the session ever reach a state GitHub can see? | Sets the default timeout |
| S7 | Maximum session length and concurrency on the target plan | Sets `maxConcurrent` and `timeoutMinutes` defaults |
| S8 | Does a fire answered `429` ever create a session? FIRE does not say | FR-015 waits and fires again after a `429`. That is safe only if a `429` creates nothing |
