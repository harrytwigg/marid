# Feature Specification: Cloud Handoff

**Feature Branch**: `docs/cloud-handoff-spec`

**Created**: 2026-11-03

**Status**: Draft. Waiting on the operator's answers to Q1 to Q5 (end of this file). Nothing is
built yet, and Q1 decides whether anything will be.

**Input**: the operator asked for an optional, opt-in way to hand delegated work to Claude's
cloud (Claude Code on the web, cloud sessions) instead of running it only on local or
build-host engines. The motivation was that Claude subscription plans can include free cloud
credit, so an operator who has it should be able to spend it on delegated work. It must be
off by default and enabled per instance, and ideally per employee, engine or account.

## Recommendation *(read this first)*

**Defer. Keep this spec as the design, and build nothing until one of the triggers below
holds.** If the operator wants to move now, run the Phase 0 spike only (`tasks.md`), and
build Phase 1 only if the spike passes.

Why:

1. **The credit is about to expire, and it never covered the only automatable path.** The
   cloud-session bonus credit expires on 2026-11-04 at 11:59 PM PT and excludes routines
   (research R7). Routines are the only documented way to start an Anthropic-hosted session
   unattended (R2.1). So the credit could not have paid for automated handoffs, even with a
   working feature today.
2. **After that, a cloud session adds no model capacity.** It draws the same plan limits as
   a local session on the same account (R7). A second account adds capacity, but the
   gateway can already run a second account locally through a Claude profile.
3. **The platform has no API to read results or cancel a session.** Results come back only
   through GitHub (R4). There is no stop call (R5), and OAuth-based control needs a human to
   log in every 30 days (R6). A handoff built on that works, but it is blind while it runs and
   cannot be cancelled.

What a cloud session still buys: compute and wall-clock off the build host, more parallel
work than the host's CPU allows, and work that carries on while the host is down.

**Triggers to revisit**:

- Anthropic offers cloud-specific credit or capacity again, including for routines.
- A documented session read or status API ships.
- Build-host CPU becomes the measured bottleneck for delegated work.

If built, the reduced version below is the design: one-shot handoffs of a delegated Todo
through a pre-made routine, with the result read from GitHub.

## Why This Matters *(constitution Principle II)*

As specified, Phase 1 sits on **rung 4**. It moves no decision to the system. An agent or the
operator chooses to hand work off, and the system carries it out and brings the result back.
It stops at rung 4 on purpose:

- **Rung 2 is not reachable honestly.** Rung 2 would let the system choose to send work to
  the cloud when local capacity runs out. That needs a capacity reading the system can trust,
  and today there is none: the gateway cannot see cloud usage separately (R7, S5), and a
  cloud session spends the same account's limits.
- **Rung 1 would spend without a meter.** An unattended start ("work starts without a human
  starting it") would spend subscription usage the gateway cannot measure. Principle II does
  not license unbounded spend.

Phase 3 (`plan.md`, Rollout) names what would have to be true to climb.

The feature adds **no** MCP tool and no tool-schema field. Selection reuses the free-form
`engine` string that `delegate_task` and the Todo dispatch override already take (research,
`src/mcp/delegation-tools.ts:108`), so the manifest budget does not move (Principle IV).

## Scope

**In (Phase 1)**:

- An engine named `claude-cloud`, registered only when the feature is enabled. A delegated
  session on it fires a pre-made routine with a generated brief and waits for the result.
- A gateway-side watcher that reads the result from GitHub and returns it to the owning
  session and Todo through the existing callback path.
- Count caps and a timeout, a stop that is honest about what it cannot stop, and a doctor
  check.

**Out**:

- Interactive chat with a cloud session.
- The gateway's MCP tools inside the cloud (plan D4).
- Scoped and dedicated departments (FR-009).
- Auto-dispatch to the cloud (rung 1 or 2).
- Self-hosted environments.
- Claude Managed Agents (R9): API-billed, and a different product. A separate spec if the
  motivation is ever API spend.
- Teleporting a cloud session into a local one.

## Current state *(facts the spec depends on)*

The full table is in `research.md`. The load-bearing facts:

- An engine is one awaited `run()` (`src/shared/types.ts:110`). A turn can wait for hours. A
  5 s heartbeat writes `lastActivity` while `run()` is pending
  (`src/sessions/turn/heartbeat.ts:5`). The status reconciler looks at a `running` session
  only once that is 45 s stale (`src/gateway/status-reconciler.ts:50`).
- Creation refuses any engine with no model-registry entry
  (`src/sessions/session-patch.ts:65`). The registry has an entry for every name in
  `ENGINE_NAMES`, whatever the config says (`src/shared/models.ts:447`). So the off switch
  has to be the registry entry itself, not list membership.
- A child's result reaches its parent through `notifyParentSessionAndWait`
  (`src/sessions/callbacks.ts:112`), keyed and retried durably. A new engine needs no
  callback code of its own.
- Scoped departments may run `claude` only (`src/sessions/turn/scoped-turn.ts:15`,
  `src/work-items/dispatch-config.ts:212` and `:279`). Any other engine name is already
  refused there.
- The gateway's tools are reachable off-host only as `/api` with the gateway bearer
  (operator-level) or `/mcp` with a Cloudflare Access assertion
  (`src/gateway/remote-mcp/http.ts:217`). Neither is safe to hand to a cloud VM (plan D4).
- The only enforced spend ceiling is per employee, per month, in USD, checked before a turn
  (`src/gateway/budgets.ts:6`). A handoff reports $0, so that ceiling cannot bound it.

## User Scenarios & Testing *(mandatory)*

### User Story 1: A manager hands a delegated Todo to the cloud (Priority: P1)

A manager employee delegates a coding Todo to an employee who is opted in to cloud handoff,
with `engine: "claude-cloud"`. The gateway fires the routine for that employee's target
repository, with a brief built from the delegation. The delegate session shows
`running`, with status lines for each stage: fired (with the cloud session link), branch
pushed, PR opened. When the cloud session opens its draft PR with a `done` result block, the
delegate session settles, and the manager is woken with the PR link, the branch and the
cloud session's own summary, framed as data. The manager then sends the branch to QA as it
would any other.

**Why this priority**: it is the feature.

**Independent Test**: on an ephemeral gateway with the feature enabled, a fake routine
endpoint and a fake GitHub API, delegate with `engine: "claude-cloud"`. The fake endpoint
receives one fire whose text contains the output contract and the handoff's branch name. When
the fake GitHub serves a PR on that branch with a `done` block, the delegate session settles
`succeeded`, and the parent receives exactly one callback containing the PR URL.

**Acceptance Scenarios**:

1. **Given** the feature is enabled, and the delegate is listed on exactly one target,
   **When** a manager delegates with `engine: "claude-cloud"`, **Then** exactly one fire is
   sent, and a handoff record is opened with a fresh nonce and the session's id.
2. **Given** an open handoff, **When** GitHub shows a PR from the handoff's branch with a
   `done` block, **Then** the turn settles `succeeded`, and the parent's callback carries the
   PR URL, the branch, the cloud session URL and the summary, framed as untrusted text.
3. **Given** an open handoff, **When** the PR's block says `blocked`, **Then** the turn
   settles `failed` with the cloud session's question in the result, and the Todo derives
   `blocked` through the existing reconcile.
4. **Given** the routine fire returns `429` with `Retry-After`, **When** the turn settles,
   **Then** it takes the existing rate-limit wait path, and the session waits and fires
   again after the reset. It never falls back to a local engine.

### User Story 2: The operator opts in, and nothing changes until they do (Priority: P1)

The operator creates a routine at claude.ai for one repository, with no connectors, and an
environment whose network level they chose. They generate its API token and put the fire URL
and the token in the gateway's environment. They then add a `cloudHandoff` block to
`config.yaml` naming the target and the employees allowed to use it. Until they do,
`claude-cloud` is an unknown engine everywhere.

**Independent Test**: with no `cloudHandoff` block, `delegate_task` with
`engine: "claude-cloud"` is refused **at creation** as an unknown engine. No session or Todo
attempt is created, `/api/engines` does not list it, and no watcher runs. With
`enabled: false` and a full block, the result is the same.

**Acceptance Scenarios**:

1. **Given** no block, or `enabled: false`, **When** anything names `claude-cloud`, **Then**
   it is refused exactly as an unknown engine is today.
2. **Given** `enabled: true` with a target missing its token, **When** the gateway loads the
   config, **Then** the feature reports `misconfigured`, the engine is not registered, and
   `jinn doctor` names the missing field without printing any secret.
3. **Given** an employee not listed on any target, **When** a delegation names them with
   `claude-cloud`, **Then** it is refused with a message naming the opt-in.

### User Story 3: A handoff is stopped, or times out (Priority: P2)

The operator, or the delegating manager, stops the delegate session. The gateway cannot stop
the cloud session, because no API exists. It stops waiting, marks the handoff `abandoned`,
settles the turn `interrupted`, and tells the parent plainly that the cloud session may still
be running, with its link. A handoff that sees no `done` or `blocked` block within
`timeoutMinutes` settles `failed` with `timed out` and the same link. The text says the cloud
session may be waiting at a permission prompt or a question that only the claude.ai page
shows (research R5).

**Independent Test**: stop a session with an open handoff. No further GitHub polls are made
for it, the result text says the cloud session was not stopped and gives the link, and a PR
that appears later does not reopen the session.

### User Story 4: The gateway restarts while a handoff is open (Priority: P2)

The gateway restarts during a handoff. Boot marks the session `interrupted` and replays its
queue item, as it does for every engine. The replayed turn finds the open handoff and
re-attaches to it, with no new fire. The result is delivered once, through the normal
settle.

**Independent Test**: open a handoff on a child Todo whose parent is `executing`. Restart the
gateway with the queue replay in place, then serve the `done` PR. The test checks:

- exactly one fire in total;
- exactly one parent callback, with the delegation completion contract applied;
- the child Todo never leaves `executing` before the result: no child-settle row is written,
  and no tree wake reaches the parent's owner;
- its open run is closed only by the real settle.

### User Story 5: Rework on the same branch (Priority: P3)

QA rejects the cloud branch. The manager sends the findings to the same delegate session.
The next turn is a new handoff whose brief says to continue on the existing branch and PR,
and it fires the routine again.

**Independent Test**: after a `done` handoff, a second message to the session produces a
second fire whose text names the first handoff's branch, and the watcher accepts a new
result block on the same PR, matched to the new nonce.

### Edge Cases

- **Two handoffs claim one PR.** A result block carries its handoff's nonce. A block with
  another nonce is ignored.
- **The PR appears without a block.** The handoff keeps waiting until it times out. It then
  reports the PR it saw, so the work is not lost.
- **The branch is pushed but no PR is opened** (S3). If the head commit carries the
  `Handoff-Result:` trailer (`contracts/handoff-brief.md`), it is read from there.
- **A fire succeeds but its response is lost** (network), or the endpoint answers 5xx.
  There is no idempotency key (R3), and a 5xx may still have created a session. The handoff
  is recorded as `fired-unconfirmed` and is **not** retried automatically, because a
  duplicate cloud session spends real usage. The watcher keeps polling the branch until the
  timeout, in case the session was created.
- **The routine was edited to attach connectors.** The gateway cannot see this, because the
  token has no read access (R3). The doctor check and the operator guide say so. Plan risk
  K3.
- **A follow-up message arrives while a handoff runs.** It queues behind the running turn,
  as any message does today. It is not forwarded to the cloud session in Phase 1.
- **The cloud session's text tries to instruct the parent.** The summary is clipped,
  stripped of anything outside the block's fields, and framed as data (FR-011).
- **Concurrency or daily cap reached.** The turn is refused before any fire, with the cap
  named. Nothing is queued behind the cap in Phase 1.

## Requirements *(mandatory)*

### Functional Requirements

**Opt-in and selection**

- **FR-001**: The feature is off unless `cloudHandoff.enabled` is `true` in `config.yaml`.
  When it is off:
  - `claude-cloud` has no model-registry entry and no engine registration, and it is not in
    `ENGINE_NAMES`;
  - it is refused at creation as an unknown engine, before any session or attempt exists;
  - no watcher runs, and no outbound call is made.
- **FR-002**: When it is enabled but invalid, the feature fails closed (`misconfigured`). The
  gateway still boots, the engine is not registered, and the doctor names each problem.
  Secret values are never printed.
- **FR-003**: Only an employee listed in exactly one target's `employees` may run on
  `claude-cloud`. The validator refuses an employee listed on two targets.
- **FR-004**: `claude-cloud` is selected through the existing selection paths only: the
  `engine` field of `delegate_task`, the Todo dispatch override, or an employee's YAML
  `engine`. No MCP tool or tool property is added.
- **FR-005**: The `claude-cloud` registry entry offers no model choices. Any explicit `model`
  is refused at creation, with a message saying that the routine fixes the model. Effort is
  ignored.

**Running a handoff**

- **FR-006**: A turn on `claude-cloud` opens a handoff record before it fires. The record has
  a random nonce, the target, the session, the Todo (if any) and the branch name. The turn
  then sends exactly one fire, whose `text` is the brief in `contracts/handoff-brief.md`.
- **FR-007**: The brief contains only these:
  - the delegation's task text;
  - the instance's operator-written preamble file, if present;
  - the output contract.

  It never contains the employee persona, the department instructions, Notes, memory, MCP
  configuration, the gateway URL or any credential.
- **FR-008**: While the handoff is open, `run()` stays pending, so the turn heartbeat keeps
  the session `running`. `isAlive` reports the awaited handoff as live, as a backstop. The
  engine emits a status line at each change it sees: fired, branch seen, PR seen.
- **FR-009**: A session in a scoped or dedicated department is refused `claude-cloud` by the
  existing gates (`src/sessions/turn/scoped-turn.ts:15`,
  `src/sessions/scoped-engine.ts:20`, `src/work-items/dispatch-config.ts:212` and `:279`).
  This feature adds no exemption.
- **FR-010**: `claude-cloud` never appears in a fallback chain. The validator checks chain
  entries against `ENGINE_NAMES`, which does not contain it. A `claude-cloud` session never
  falls back to another engine: its fallback mode is `auto-resume`, whatever was asked.

**Results**

- **FR-011**: The watcher reads results from GitHub only. That means the PR whose head is the
  handoff's branch, and failing that, the branch's head commit trailer. It accepts a result
  only if its nonce matches. It passes on the `status` (`done`, `blocked` or `failed`), a
  summary clipped to a fixed length, the PR URL, the branch and the cloud session URL. All of
  it is framed as untrusted text in the result.
- **FR-012**: `done` settles the turn `succeeded`. `blocked` and `failed` settle it `failed`.
  No result within `timeoutMinutes` of the fire settles it `failed` with `timed out`. Every
  outcome reaches the parent through the existing callback path, exactly once.
- **FR-013**: The engine never calls undocumented endpoints. Creation uses the documented
  fire endpoint. Reading uses GitHub's REST API with the configured read-only token.

**Limits, stop and restart**

- **FR-014**: The gateway refuses a fire, before sending it, when either cap would be
  exceeded: `maxConcurrent` open handoffs per instance, or `maxPerDay` fires per instance
  per UTC day. These count caps are the feature's stated spend ceiling (Principle II). The
  defaults are 1 and 4.
- **FR-015**: Fire answers are handled as follows:
  - A `429` settles the turn as rate-limited, with `Retry-After` as the reset, so the
    existing wait path retries it. This assumes the endpoint creates no session on a `429`.
    The docs do not say so, so it is inferred, and Phase 0 confirms it (S8).
  - A 4xx other than `429` settles the turn `failed` with the status and error type.
  - A 5xx, or no response at all, is recorded `fired-unconfirmed`. It is never retried
    automatically, and the branch is polled until the timeout.
- **FR-016**: Stopping a session with an open handoff stops polling, marks the handoff
  `abandoned`, and says in the result that the cloud session was **not** stopped, with its
  link. A result that arrives later is ignored.
- **FR-017**: A turn on a session with an open handoff re-attaches to it, whatever its
  prompt, and never fires. After a restart, the queue replay that boot already performs is
  that turn. No extra turn is enqueued. A result is delivered only through `settleTurn`.
  An open handoff that no turn re-attaches is closed `timed-out` at `timeoutMinutes`, with no
  delivery.
- **FR-017a**: A session with an open handoff counts as in flight wherever the gateway
  derives a Todo's status or closes its runs. That includes the startup and periodic sweep
  `closeRunsForSettledSessions`. So a restart neither moves the Todo to `blocked`, nor wakes a
  parent's owner, nor closes its run.
- **FR-017b**: At boot, if the feature is off or misconfigured, every open handoff is closed
  `abandoned` before the startup reconcile, and a log line names each one. Its Todo then
  derives from the real receipt. The flag takes effect at boot.
- **FR-017c**: Each Todo has at most one open handoff. Starting a further `claude-cloud`
  session for that Todo is refused at creation, on every start path. The refusal names the
  open handoff and its cloud session link. A partial unique index is the backstop.
- **FR-018**: A later turn on a session whose last handoff reached `done`, `blocked` or
  `failed` opens a new handoff. Its brief names the earlier branch and PR to continue on.

**Visibility**

- **FR-019**: The session view shows the cloud session link and the handoff's state.
  `/api/engines` lists `claude-cloud` only when it is registered. The doctor reports the
  feature as one of off, misconfigured or ready, with per-target problems.

### Config schema *(the opt-in)*

The block lives in a new top-level `cloudHandoff` key, validated by
`src/shared/cloud-handoff-config.ts`, in the same way as `remote-mcp-config.ts`. Secrets are
always `${VAR}` references, resolved by `resolveEnvVar` (`src/shared/env-ref.ts:17`). A
literal token is a validation error.

```yaml
cloudHandoff:
  enabled: false              # master switch; absent means false
  maxConcurrent: 1            # open handoffs per instance (1..10)
  maxPerDay: 4                # fires per UTC day per instance (1..100)
  timeoutMinutes: 240         # from fire to result (30..1440)
  pollSeconds: 120            # GitHub poll interval per open handoff (30..900)
  preambleFile: cloud-handoff/preamble.md   # optional, relative to the instance home
  github:
    token: ${CLOUD_HANDOFF_GITHUB_TOKEN}    # read-only: contents and pull requests
  targets:
    example-app:              # target name, [a-z0-9-]{1,40}
      repo: example-org/example-app         # must equal the routine's repository
      fireUrl: ${CLOUD_HANDOFF_EXAMPLE_APP_URL}
      token: ${CLOUD_HANDOFF_EXAMPLE_APP_TOKEN}
      employees: [example-developer]        # required, non-empty; one target per employee
      branchPrefix: claude/handoff-         # optional; the nonce is appended
```

Rules:

- `fireUrl` must be `https://api.anthropic.com/v1/claude_code/routines/trig_.../fire`.
- `repo` is `owner/name`.
- Unknown keys are errors.
- Per-account billing attribution (`account:`) is **not** in Phase 1, because it has no
  consumer until S5 is answered (Principle V). Phase 2 adds it if S5 says the usage
  reading sees cloud sessions.

### Security and privacy

- **What leaves the gateway.**
  - The fire sends the brief to Anthropic. Anthropic stores the session transcript for 30
    days on commercial plans. On consumer plans it is 5 years if the account allows model
    improvement, otherwise 30 days (R8).
  - The repository is cloned into the VM, and what the session writes goes to GitHub under
    the routine owner's identity.
  - Nothing else leaves: no persona, Notes, memory, MCP config, gateway address or
    credential (FR-007).
- **What stays local.**
  - All of the gateway's tools, the Todo ledger, Notes, memory, department scoping,
    secrets, and review. The cloud session cannot call the gateway (plan D4).
  - QA of the cloud branch runs locally, as for any other branch.
- **Credentials.**
  - The routine token can fire that one routine and nothing else (R3).
  - The GitHub token is read-only, and should be limited to the target repositories.
  - Both live in the gateway's environment, never in `config.yaml`, and are redacted from
    `GET /api/config` by the existing key-name rule.
- **Connectors.**
  - A routine attaches the account's claude.ai connectors unless they are cleared (R3). A
    cloud session with a chat or ticketing connector could act on those services as the
    operator.
  - The operator guide requires creating the routine with connectors cleared. The doctor
    reminds the operator of this, because the gateway cannot verify it.
- **Network.** The operator picks the environment's network level. The guide recommends
  Trusted (the default allowlist) and environment network secrets for anything the build
  needs, never plain environment variables (R8).
- **Public text.**
  - On a public repository, the branch, commits and PR are public. The brief carries the
    repository's own public-safety rules through the operator's preamble.
  - The nonce is random and is not a Todo or session id, so nothing internal appears in a
    branch name.
- **Prompt injection.** The cloud session reads the repository and possibly the web, so the
  PR body is untrusted. Only the block's typed fields are passed on, clipped and framed as
  data (FR-011).
- **Spoofing.** Anyone with push access could open a PR on a `claude/handoff-<nonce>`
  branch. The nonce is unguessable (96 bits) and is never published before the fire. Plan
  risk K5.

### Key Entities

- **Cloud handoff**: one fire and its outcome. It is owned by one session and optionally one
  Todo. Its state is one of `opened`, `fired`, `fired-unconfirmed`, `done`, `blocked`,
  `failed`, `timed-out` or `abandoned`. It also records the branch, the PR URL and the cloud session
  URL. See `data-model.md`.
- **Target**: one routine, meaning one repository, the routine's token, and the employees
  allowed to use it.

## Success Criteria *(mandatory)*

- **SC-001**: With the feature off, creation refuses `claude-cloud` as an unknown engine,
  `/api/engines` omits it, and a full test run shows no outbound call to the routine
  endpoint or to GitHub.
- **SC-002**: In the Phase 0 spike, three handoffs on a throwaway repository each come back
  with a PR and a matching `done` block, with no human touching claude.ai between fire and
  result.
- **SC-003**: Each handoff produces exactly one fire and exactly one parent callback across
  a gateway restart (US4), a lost fire response (no retry), and a stop (no callback after
  the abandon notice).
- **SC-004**: The caps hold: with `maxConcurrent: 1`, a second delegation while one is open
  is refused before any outbound call.
- **SC-005**: A scoped-department session naming `claude-cloud` is refused by the existing
  gate, and the department-scope route tests still pass unchanged.
- **SC-006**: The manifest budget test (`tool-manifest-budget.test.ts`) passes without
  changes.

## Assumptions

- The operator's repositories are on GitHub. Anthropic-hosted sessions cannot push to
  anything else (R1).
- The operator can create routines on their plan (Pro, Max, Ultra, Team or Enterprise).
- The routine fire endpoint keeps its documented shape. It is marked experimental (R2.1), so
  the adapter is small and isolated.
- A cloud session follows an output contract given in its brief well enough to be useful.
  This is S1, the spike's main question.

## Open Questions for the Operator

### Q1: Build, defer, or reduce?

- **A. Defer (recommended).** Merge this spec as the design and build nothing. Revisit on
  any trigger in the Recommendation.
- **B. Phase 0 spike only.** About half a day:
  - the operator creates one routine on a throwaway repository;
  - a short script fires it three times;
  - S1 to S7 are recorded in `research.md`.

  No gateway code is written.
- **C. Phase 0, then Phase 1.** Three to five days of senior work after a passing spike
  (`tasks.md`).

Whatever you pick: the credit expires on 2026-11-04 at 11:59 PM PT. If you want to spend what
is left, do it by hand at claude.ai/code. Nothing built here would land in time.

### Q2: Creation path

- **A. Routine fire (recommended).** Documented, with a per-routine token and no 30-day
  login. The cost is one web-UI routine per repository, and the model and connectors are
  fixed per routine.
- **B. OAuth CLI with `--environment`.** Any repository and ref per call, plus follow-ups
  into the live session. Possible only if S2 passes. The cost is a human login every 30 days
  per account (R6).

### Q3: Which account

Should the routine live on the account the gateway already uses locally (simplest, shared
limits), or on a dedicated account? A dedicated account adds capacity only if it is a
separate subscription, and that subscription could equally run locally through a Claude
profile.

### Q4: Data egress

Are you content for delegated task text and the repository to be processed and kept by
Anthropic under the account's retention setting (R8)? If the account is a consumer plan,
check its model-improvement setting first.

### Q5: Private repositories

Should Phase 1 allow private repositories, or public only? The repository rules about
public text apply either way. A private repository mostly changes what the session
transcript holds.
