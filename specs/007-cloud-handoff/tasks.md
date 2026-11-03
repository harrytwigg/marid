# Tasks: Cloud Handoff

**Input**: [plan.md](./plan.md), [data-model.md](./data-model.md),
[contracts/handoff-brief.md](./contracts/handoff-brief.md)

Nothing here starts until the operator answers Q1 in the spec. With Q1 = B, only Phase 0
runs. With Q1 = C, Phase 1 starts only after Phase 0 passes.

These rules apply to every task:

- **Size ratchet.** New files stay at or under 300 lines. `gateway/api.ts`,
  `gateway/server.ts` and `sessions/registry.ts` grow by registration lines only.
- **Gates.** `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` stay green.
- **Manifest budget.** `tool-manifest-budget.test.ts` passes unchanged (SC-006).
- **No real network.** Tests use loopback fakes for the routine endpoint and GitHub, with
  `fetch` and the clock injected.

## Phase 0: Spike (no gateway code)

This phase is run by the operator with the senior developer. Its scratch script stays out of
the repository.

- [ ] T001 Operator: create one routine on a throwaway **public** repository, following the
  routine section of `contracts/handoff-brief.md` (connectors cleared, network Trusted).
  Put its fire URL and token in a local environment file, never in a commit.
- [ ] T002 Fire it three times with the brief template: a trivial change, a change that
  needs a test run, and a task built to be `blocked`. Poll GitHub REST as section 3 of the
  contract describes, then record:
  - S1: whether each run obeyed the branch name and the block;
  - S3: whether the PR was opened through REST or only the trailer was written;
  - S6: how long each took, and what the `blocked` run left visible on GitHub.
- [ ] T003 Record S4: does the token's page show an expiry? Record S5: before and after the
  runs, compare the account's usage on claude.ai with the gateway's own Limits reading for
  that account. Record S7 from the plan's documentation or the account's limits page.
- [ ] T004 Optional, for Q2 = B: from a logged-in CLI, try
  `claude -p "<brief>" --environment <the Anthropic-hosted environment id> --output-format json`
  once, and record S2. Note: this creates one real cloud session.
- [ ] T005 Write the answers into the UNVERIFIED table of `research.md`, change spec
  status to "Spike done", and give a go or no-go for Phase 1 in one paragraph.

**Go criteria**: S1 holds on all three runs. S3 holds, or the trailer fallback worked on
every run.

## Phase 1: MVP (behind `cloudHandoff.enabled`)

### Foundation

- [ ] T010 [P] `src/shared/cloud-handoff-config.ts`: the type, defaults, and
  `cloudHandoffProblems(value)`:
  - the ranges, the target-name pattern and the `fireUrl` shape;
  - `${VAR}`-only secrets;
  - one target per employee;
  - unknown keys are errors.

  Hook it into `validateConfigShape` (`src/shared/config.ts:37`) and add `cloudHandoff` to
  `CONFIG_TOP_LEVEL_KEYS`. Tests: every rule has a failing case and a passing case.
- [ ] T011 [P] Migration adding `cloud_handoffs`, per `data-model.md`, with its CHECK. Tests:
  the CHECK refuses an open row with `closed_at`, and a closed row without it.
- [ ] T012 `src/engines/cloud-handoff/store.ts`:
  - open a row with the cap check in one transaction (FR-014);
  - close exactly once;
  - list open rows, and the latest row by session.

  Tests: two concurrent opens against a cap of 1 give exactly one success, using an injected
  clock for the UTC day.
- [ ] T013 Plan D9. `buildRegistry` (`src/shared/models.ts:441`) adds a `claude-cloud` entry
  with no model choices **only** when `cloudHandoff` is enabled and valid. The engine is
  **not** added to `ENGINE_NAMES`. Add a rate-limit label. Audit every lookup by
  `session.engine` that assumes an `EngineName` (engine health, limits, the UI engine lists),
  and list each one in the PR with what it does for `claude-cloud`. Tests:
  - feature off: creation is refused with `unknown engine`, no session row exists, and
    `/api/engines` omits it;
  - feature on: it is listed, and an explicit `model` is refused (FR-005);
  - a fallback chain naming it is refused as unknown (FR-010).

### The engine

- [ ] T020 `src/engines/cloud-handoff/brief.ts`: build the brief from the contract. Inputs
  are the task text, the preamble file, the branch, the base, the nonce, and the previous
  branch and PR for a continuation. Tests:
  - it clips to 65,536 characters with a note;
  - it contains none of the FR-007 exclusions, given a session whose persona and
    environment contain sentinel strings.
- [ ] T021 `src/engines/cloud-handoff/fire.ts`: the POST, with `fetch` injected. It maps:
  - `200` to `fired`;
  - `429` with `Retry-After` to a rate-limited result;
  - any other 4xx to `failed`, with the error type;
  - a 5xx, or a network failure after the request was sent, to `fired-unconfirmed` (no
    retry).

  Tests: one per mapping. A pinned test that only the configured `fireUrl` host and path are
  ever called (FR-013).
- [ ] T022 `src/engines/cloud-handoff/result.ts`: find and parse the block, and fall back to
  the trailer (contract section 3). Tests:
  - a wrong nonce is ignored;
  - the last block wins;
  - an oversized summary is clipped;
  - control characters are stripped;
  - a missing PR falls back to the trailer.
- [ ] T023 `src/engines/cloud-handoff/watcher.ts`:
  - one interval timer, polling per handoff by `next_poll_at`;
  - GitHub REST calls with the read-only token;
  - the timeout, which uses the injected clock;
  - it settles the registered promise once.

  Tests: a fake GitHub serves the PR on the third poll, giving exactly one settle. A timeout
  settles `timed-out`. A poll after the row was abandoned does nothing.
- [ ] T024 `src/engines/cloud-handoff/engine.ts`: `CloudHandoffEngine implements
  InterruptibleEngine`.
  - `run()` refuses a non-default model (FR-005), opens a row, fires, emits status deltas,
    and awaits the watcher. It maps the result to `EngineResult` (plan D6).
  - `isAlive` is true while the row is open and awaited.
  - `kill` abandons the row (FR-016). `killAll` and `killIdle` do nothing to cloud state.

  Tests: each outcome produces the result text in contract section 4.
- [ ] T025 Register it in `src/gateway/server.ts:735`, only when the config validates and is
  enabled. Start the watcher with the gateway, and stop it on shutdown. Tests (SC-001):
  - with the feature off, delegating to `claude-cloud` gets the unknown-engine refusal at
    creation, and the fakes record zero requests across the run;
  - the red check: force the registry entry and registration on, and watch both assertions
    fail.

### Gateway integration

- [ ] T030 Re-attach (FR-017, plan D5). `run()` re-attaches to an open handoff on its
  session, whatever the prompt. Nothing new is enqueued at boot, and restart-resume is not
  changed. Tests (SC-003), run through the real boot sequence (`recoverStaleSessions`,
  `recoverStaleQueueItems` and the queue replay):
  - exactly one fire in total across a restart;
  - exactly one parent callback, from `settleTurn`, with the completion contract applied;
  - the Todo derives `executing` while the replay waits, then follows the real result;
  - a session with no queue item, re-attached by a nudge turn, also fires nothing;
  - an open handoff with no turn closes `timed-out` at `timeoutMinutes` without a delivery;
  - a deleted session's handoff becomes `abandoned`.
- [ ] T031 Continuation (FR-018). A turn after a closed handoff opens a new row with
  `continues_handoff_id`, and the brief names the earlier branch and PR. Test: the second
  fire's text contains the first branch.
- [ ] T032 Pin the existing gates with tests:
  - a scoped-department session naming `claude-cloud` is refused by `refuseScopedTurn` and
    by the dispatch override check (FR-009, SC-005);
  - a `claude-cloud` session's fallback mode is `auto-resume` (FR-010).
- [ ] T033 Visibility (FR-019):
  - the doctor section reports off, misconfigured or ready, with per-target problems. It
    names missing variables but never prints values, and it always carries the reminder
    that routines must have connectors cleared;
  - `/api/engines` lists `claude-cloud` only when it is registered;
  - the session view shows the cloud session link and the handoff state, from a small
    read-only route.
- [ ] T034 Pin K11: a Todo whose session waits five hours of fake time in a handoff turn,
  with the heartbeat running, is flagged by neither `classifyStalledExecution` nor
  `executionTimeout`.

### Docs and verification

- [ ] T040 `docs/cloud-handoff.md`, the operator guide:
  - what it is and is not;
  - the billing reality, with the date the credit ended;
  - creating the routine (connectors cleared, network level);
  - the environment variables;
  - the config block;
  - stop semantics;
  - data retention.

  Link it from `docs/remote-execution.md`'s introduction, as a different kind of "remote".
- [ ] T041 Functional run on an ephemeral gateway with a temporary home, its own port, and
  the fake routine and GitHub servers. Drive US1 to US4 through the real API, and attach the
  transcript excerpts and a session-view screenshot to the PR.
- [ ] T042 With the operator's go-ahead only, run one real end-to-end handoff against the
  Phase 0 throwaway repository, and attach the PR link. This is outward-facing: it creates a
  real cloud session.

## Phase 2: Ledger and attribution (only once Phase 1 is in use)

- [ ] T050 Fill the Todo run's `summary` and `handoff` from the result (`data-model.md`,
  Phase 2).
- [ ] T051 If S5 holds: add `account:` to targets, attribute handoffs on the Limits page, and
  refuse a fire while that account is recorded rate-limited.
- [ ] T052 A PR author check (risk K5).
- [ ] T053 If Q2 = B and S2 holds: follow-ups into a live cloud session through the OAuth CLI,
  with the 30-day login surfaced through the existing auth watch (`docs/claude-auth.md`).
