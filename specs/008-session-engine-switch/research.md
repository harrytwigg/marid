# Research: Engine and Profile Switching for a Chat

Paths are relative to `packages/jinn/src` (gateway) or `packages/web/src` (web) unless
they start with `packages/` or `docs/`.

## R1. Knowing whether a native compaction worked

- **Decision**: a compaction counts as succeeded only when the engine confirmed it (Claude:
  the `PostCompact` hook plus the transcript's `compact_boundary`, which sets
  `result.compaction`; opencode server: `/summarize` answered `true`; opencode 2:
  `session.compaction.ended`) **and** its summary text was read back (R2). Anything else
  (no `result.compaction`, an error, a usage limit settled by `settleRateLimitedCompaction`,
  a stop, or no outcome recorded by the time the resume turn starts) is a failure.
- **Where**: `sessions/turn/settle.ts` `announceCompaction` (~189) is the single place every
  compaction turn settles; it gets a hook that records the outcome on the pending switch.
- **Bound**: the compaction turn's own turn timeout. The session queue is serial, so the
  resume turn starts only after the compaction turn has settled one way or another; an
  outcome still missing then is a failure. No separate timer is needed.
- **Alternatives**: polling the transcript for a summary from the resume turn (racy);
  a separate watchdog timer (the serial queue already bounds it).

## R2. Reading the compaction summary back

- **Today**: nothing reads the summary text. `CompactionStats` holds only token counts;
  `gateway/external-turns.ts:65` and `CompactionStreamGate` only filter the summary out.
- **Decision**: a new reader, `sessions/compaction-summary.ts`, per engine:
  - Claude: in the conversation's transcript (`gateway/session-claude-profile.ts`
    `findTranscriptOfSession`), the first `user` entry after the newest `compact_boundary`
    is the summary ("This session is being continued from a previous conversation…").
  - opencode server 1.x: the `summary: true` assistant message's text parts (the message
    `summaryReport` already locates in `engines/opencode-server-compaction.ts`).
  - opencode 2: the summary message the compaction produced, if the API exposes it; if not,
    the reader returns nothing and the switch takes the manual handover (FR-015b allows it).
  - Every other engine: nothing (they have no native compaction Jinn drives).
- Capped at 16,000 characters; a longer summary is cut at a paragraph boundary with a note,
  because it is a summary, not the history (the history pointer still follows it).

## R3. A compaction turn that must not walk a fallback chain

- **Finding**: compaction turns already never walk the chain: `turn/runner.ts:277` routes a
  limited compaction turn (`plan.compaction`, set by `isCompactCommand`) to
  `settleRateLimitedCompaction`, which records the limit and settles. **No change needed**;
  the outcome hook (R1) reads that path as a failure.

## R4. Where the switch is applied

- **Finding**: outbox deliveries are message-only (`sessions/callbacks.ts`
  `deliverClaimedSessionDelivery` posts to the message route). `runWebSession`
  (`gateway/web-session-dispatch.ts:177-186`) re-reads the session row and the queued
  prompt when a turn starts, and already runs `maybeRevertEngineOverride` there.
- **Decision**: the pending switch lives in `transportMeta.pendingSwitch` (data-model.md).
  The resume turn is queued through the outbox exactly as `compact_session`'s, with
  `meta.switchResume = <claimedAt>`. When `runWebSession` starts a turn whose meta carries a
  `switchResume` matching the pending switch, it calls `applyPendingSwitch` **before** the
  engine is chosen: re-validate the target, apply it (or record why not), clear the pending
  record, and rebuild the turn's prompt from the record (R6). Durable across restarts
  because both the outbox row and `transportMeta` are durable.
- **Alternatives**: applying at compaction settle (would run before a stop could withdraw
  the resume, and the settle hook has no prompt to rewrite).

## R5. Changing the Claude account of an existing session

- **Finding**: `claudeConfigDir` is written only at creation; `UpdateSessionFields` lacks it;
  the per-turn profile comes from `session-account.ts` `sessionClaudeProfile`
  (override first, then `session.claudeConfigDir`); conversations are keyed by
  `threadSlot` = engine, or the Claude account key.
- **Decision**: a new registry write, `switchSessionTarget(sessionId, {engine, claudeConfigDir,
  model, effortLevel, leftConversation: "park" | "retire", sync: "pointer"})`, generalising
  `switchSessionEngine` (which stays as a wrapper for its existing callers):
  park (or drop, for `retire`) the current slot under its **own** account
  (`withoutAccountOverride`), write `engine`/`claude_config_dir`/`model`/`effort_level`,
  clear `transportMeta.engineOverride` and `fallbackRun` (keep `fallbackHops`), null
  `lastContextTokens`, and set the sync marker for the new slot.
- `sessions/session-account.ts` needs no change: the slot follows `claudeConfigDir`.

## R6. History pointer instead of a pasted transcript

- **Finding**: the engine-switch catch-up is `turn/preflight.ts` `resolveSyncPrompt`
  (~291), driven by `engineSyncTarget`/`engineSyncSince` (set by `switchSessionEngine`) or
  `claudeSyncSince`/`claudeSyncAccount` (set by the fallback override revert). It pastes the
  last 20 messages (`turn/sync-transcript.ts`).
- **Decision**: the sync marker gains `engineSyncMode: "pointer" | "transcript"`.
  `switchSessionTarget` writes `"pointer"`; every existing writer keeps `"transcript"`
  (absent = transcript), so fallback hops and the override revert are untouched.
  `resolveSyncPrompt` with `"pointer"` builds `historyPointerPrompt` (new,
  `turn/history-pointer.ts`):
  - says the conversation is new on this target (or, for a parked one, missed messages
    since `<ISO time>`), that the history is **not** repeated, and how to read it:
    `read_session` on the session's own id (it may read itself; `last` up to 500) and, when
    the left conversation was Claude's and its transcript file exists on this host, that
    file's path;
  - then the current message (or, for a switch resume, the resume message).
- The tool path builds the same pointer inside its resume message (manual handover), and
  carries no pointer when a compaction summary was read back (summary, then handoff).
  The pointer is still appended after the summary, one line, so the session knows where
  detail lives.

## R7. Who may switch to what

- `sessions/primary-profile.ts` refuses scoped **callers** and non-operators for scoped
  **employees** at creation. Switching gets its own resolver, `sessions/switch-target.ts`
  `resolveSwitchTarget(config, session, request, {caller: "operator" | "self"})`:
  - engine must be installed where the session runs (`sessions/availability-registry.ts`,
    `engineSupportsRemote` for remote employees);
  - profile must be a declared **local** account; refused for a remote employee's session;
  - a scoped session (`sessionScopeDepartment`): engine must be `claude`
    (`scopedSwitchRefusal`), any declared local profile allowed, for the operator and for
    the session itself (clarified 2026-11-12);
  - model must be one the engine offers (`validateNewSessionSelection`);
  - self only: refuse a target known to be out of allowance (`readEngineHealth` +
    `linkHealthKey` + `engineHealthForTarget`), naming `until`;
  - refuse a target equal to the current one (self only; the operator's PUT is a no-op).

## R8. Routes and scoping

- Switch tool: `POST /api/session-switches` (new domain module
  `gateway/session-switch-api.ts`, pattern of `self-compaction-api.ts`; session callers
  only, self only). List tool: `GET /api/session-targets` (same module; session callers
  only, answers for the caller). Both get "pass" rows in
  `gateway/department-scope/rules.ts`, like `/api/compactions`.
- Operator selector: the existing `PUT|PATCH /api/sessions/:id` (operator-only per
  `gateway/control-plane-routes.ts`) accepts `profile`; the new branch lives in a helper
  module (`gateway/session-target-patch.ts`) because `api.ts` is grandfathered against the
  complexity caps.

## R9. MCP surface

- Tools `switch_session` and `list_session_targets` join `mcp/session-tools.ts` (scoped
  sessions get the session group; not in `DEPARTMENT_REFUSED_TOOLS`). Descriptions stay one
  line; the teaching goes in `packages/jinn/template/CLAUDE.md` "Long sessions" beside
  `compact_session`, and its migration copy.
- Pinned lists to update: `mcp/__tests__/tool-manifest-budget.test.ts` (rebase
  `MAX_MANIFEST_TOKENS` + `ATTESTED`, tool count 51 → 53, with a paragraph), 
  `tool-manifest-expectations.ts`, `server.test.ts`, `session-tools.test.ts`.

## R10. Web

- `components/chat/model-selector-row.tsx` gates profiles on `mode === 'new'` (230) and shows
  the profile only when one is set (245-246); `chat-pane.tsx` passes `allowProfiles={!sessionId}`
  (612), seeds the selector without a profile (277-286) and sends
  `api.updateSession(sid, {engine, model, effortLevel})` (312, PUT). `EnginePanel` in
  `model-picker-panels.tsx` already renders profile rows when given them.
- **Decision**: enable profiles in existing mode, seed `profile` from
  `session.claudeProfile.name`, send `profile` (string, or `null` for own login) on PUT, and
  label the chip `Engine · Profile|Own login · Model` for Claude, `Engine · Model` otherwise.
  The session refetch on `session:updated` keeps the chip in step (FR-041).
