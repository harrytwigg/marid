# Research: Engine and Profile Switching for a Chat

`G/` = `packages/jinn/src/`, `W/` = `packages/web/src/`. Lines as of `origin/main` `468a6749`;
plan.md's table is the full index.

## R1. Knowing whether a native compaction worked

- Claude: `result.compaction` is set by the `PostCompact` hook alone
  (`G/engines/claude-interactive.ts:2557`); the transcript's `compact_boundary` only adds
  token stats (`:180`, `:221`). opencode server: `/summarize` answering `true`; opencode 2:
  `session.compaction.ended`.
- Not every compaction settle reaches `announceCompaction` (`G/sessions/turn/settle.ts:189`):
  it is called only from `settleAnsweredTurn` (`:168`) when the turn was not quietly
  pre-empted, and returns early on `result.error`. `settleRateLimitedCompaction` (`:120`),
  `settleThrownTurn` (`:306`), preflight refusals and restart cut-offs never call it.
- **Decision**: record the outcome on each path (plan D6), matched to the switch by the
  self-compaction focus prefix and the claim time. A path that records nothing leaves the
  default `no-outcome`, applied when the resume starts. The serial queue bounds the wait: the
  resume starts only after the compaction turn has settled, so no extra timer.

## R2. Reading the compaction summary back

- Nothing reads it today (`CompactionStats` holds token counts; `G/gateway/external-turns.ts:65`
  only filters it out).
- **Claude**: real Claude Code writes a `compact_boundary` system entry, then a user entry
  marked `isCompactSummary: true` whose text starts "This session is being continued from a
  previous conversation". A manual `/compact` also writes `<command-name>` and
  `<local-command-stdout>` user entries near the boundary, so "first user entry" is not
  enough. The reader keys on `isCompactSummary`, falls back to the prefix, accepts string or
  array content, and only considers a boundary written at or after the compaction turn
  started, polling up to ~2 s because `PostCompact` fires before the boundary lands (as
  `awaitCompactionStats` does).
- The transcript is found with `findSessionTranscript(result.sessionId, profile, cwd)`
  (`G/engines/claude-transcript-path.ts:36`) using the profile the compaction actually ran on
  (an account override's stand-in when one stands), not `findTranscriptOfSession`
  (`G/gateway/session-claude-profile.ts:25`), which reads the row and is called before
  settle files the turn's id.
- **opencode server 1.x**: `summaryReport` (`G/engines/opencode-server-compaction.ts:65`)
  already finds the `summary: true` message; it also returns its text parts.
- **opencode 2** and other engines: none; the switch takes the manual handover (FR-015b).
- **Length**: no truncation. Over 24,000 characters the summary is not used
  (`summary-too-long`) and the switch takes the manual handover.

## R3. A compaction turn never walks a fallback chain

`G/sessions/turn/runner.ts:277` routes a limited compaction turn to
`settleRateLimitedCompaction`. No change; that path records `usage-limit`.

## R4. Where and how the switch is applied

- Live resumes and boot replay (`G/gateway/callback-queue-recovery.ts:85`) both go through
  `dispatchWebSessionRun` (`G/gateway/web-session-dispatch.ts:122`, which has the
  `queueItemId`) → `runWebSession` (`:179`, which does not). `request.prompt` can be replaced
  there, as `requestForTurn` already does from the queue row.
- The message route keeps only known meta kinds, so no new meta: the delivery row already
  names the claim (`deliveryKind: "self-compaction-resume"`, `sourceAttempt:
  "self-compaction:<at>"`, read by `selfCompactionClaimOfDelivery`, `G/sessions/registry.ts:948`).
  Pass `queueItemId` into `runWebSession` and look the delivery up with
  `getSessionDeliveryByQueueItemId` (`:2509`).
- By then `beginSessionAttempt` has set the session `running`. A plain `updateSession` with
  `status: "idle"` (what `switchSessionEngine` does, `:1137`) would make the settle's fenced
  write (`completeSessionAttempt`, `:1045`) fail and the session never settle. The apply
  writes through `updateSessionForAttempt` (`:1024`) and leaves status alone, as
  `beginEngineSubstitution` (`G/sessions/engine-override.ts:135`) does.
- The apply runs before `maybeRevertEngineOverride` (`:195`), so the revert and the engine
  pick see the switched row.

## R5. Changing the Claude account of an existing session

`claudeConfigDir` is written only at creation; `UpdateSessionFields` (`:565`) lacks it; the
per-turn profile is read live (`G/sessions/session-account.ts:118`), and the PTY view already
cold-respawns on a profile change. Conversations are keyed by `threadSlot` (`:136`): the
engine, or the Claude account key, where own login is `ownClaudeAccount` (`:90`): the
employee's own profile key, or `claude` when the employee has none. The only stale reader is
the left conversation's transcript path, so it is computed before the write (plan D4).

## R6. History pointer instead of a pasted transcript

`resolveTurnPrompt` (`G/sessions/turn/preflight.ts:239`) checks the lost-conversation key
(`:35`) first for any non-resuming turn and pastes a transcript; `syncSince` (`:271`) falls
through to `claudeSyncSince` when `engineSyncTarget` does not match; and the override revert
(`G/sessions/engine-override-revert.ts:76`, `:85`) writes `claudeSyncSince` or
`engineSyncTarget`. **Decision**: `switchSessionTarget` clears all of those before setting its
own marker with `engineSyncMode: "pointer"`; the revert clears `engineSyncMode` when it writes
a marker; the three new keys are protected from adapter merges (`G/sessions/manager.ts:68`).
Every other writer keeps the pasted catch-up.

## R7. Who may switch to what

`resolvePrimaryEngine` (`G/sessions/primary-profile.ts:68`) is creation-only and refuses
scoped callers; switching gets `resolveSwitchTarget` (plan D2):
- engine installed where the session runs (`G/sessions/availability-registry.ts:11`);
- profile a declared **local** account (`G/shared/claude-accounts-config.ts:108`); refused
  for a remote employee's session;
- scoped session: engine `claude` only (`G/sessions/scoped-engine.ts:31`); any declared
  local profile, for the operator and for the session itself;
- model one the engine offers (`G/sessions/session-patch.ts:50`);
- session caller only: refuse a target known to be out of allowance
  (`G/shared/engine-health-store.ts:93`, `G/shared/engine-health.ts:52`,
  `G/shared/fallback-chain-health.ts:36`), and refuse its own target (plan D2 "own target").

## R8. Routes

No new routes. The session path extends `POST /api/compactions` (already "pass" for scoped
callers, `G/gateway/department-scope/rules.ts:95`); the operator path extends
`PUT|PATCH /api/sessions/:id` (operator-only).

## R9. MCP surface

Rung 1 (plan Constitution Check IV): `compact_session` gains `engine`, `profile`, `model`;
+28 tokens on Pi, measured. Pinned lists to update: the budget test (rebase with a paragraph;
tool count unchanged), `tool-manifest-expectations.ts` and `session-tools.test.ts`.

## R10. Web

`W/components/chat/model-selector-row.tsx:230` gates profiles on new chats;
`W/components/chat/chat-pane.tsx:612`/`:614` pass `allowProfiles={!sessionId}` and the
new-chat employee's remote flag; `W/lib/api.ts:669` has no `profile`. `EnginePanel` already
renders profile rows when given them. The session refetch on `session:updated` keeps the
chip in step (FR-041).
