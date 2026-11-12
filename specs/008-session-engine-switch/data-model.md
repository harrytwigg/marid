# Data Model: Engine and Profile Switching for a Chat

No new tables or columns. Everything below is a field already on `sessions` or a key inside
`sessions.transport_meta` (JSON). No migration bundle change is needed for data; the
template doc change (R9) does need the unreleased bundle regenerated.

## Session target (existing columns, one becomes writable)

| Field | Column | Change |
|---|---|---|
| engine | `engine` | unchanged |
| Claude profile | `claude_config_dir` | **now writable after creation** via `switchSessionTarget` only; `null` = own login |
| model | `model` | unchanged |
| effort | `effort_level` | unchanged |

Serialised as today (`engine`, `model`, `effortLevel`, `claudeProfile: {name, key} | null`).

## Conversation slots (existing, `engineSessions`)

Keyed by `threadSlot`: the engine name, or for Claude the account key. Own login is the
employee's own account (`ownClaudeAccount`): its profile key when the employee has a
`claudeConfigDir`, else `claude`; a declared profile is `claude:<profile key>`. `switchSessionTarget` with
`leftConversation: "park"` (operator) keeps the left slot so a return resumes it;
`"retire"` (a session's own switch to a new conversation) deletes it so a return starts fresh (FR-018).

## Sync marker (existing keys in `transportMeta`, one added)

| Key | Meaning |
|---|---|
| `engineSyncTarget`, `engineSyncSince` | existing: the new slot owes a catch-up from this time |
| `engineSyncMode` | **new**: `"pointer"` (history pointer, written by `switchSessionTarget`) or absent/`"transcript"` (today's pasted catch-up, every other writer) |

Cleared on a clean settle by `withSyncMarkersCleared`, which must clear `engineSyncMode` too.
`switchSessionTarget` first clears `claudeSyncSince`, `claudeSyncAccount` and the
lost-conversation key; the override revert clears `engineSyncMode` when it writes a marker.
`engineSyncMode`, `pendingSwitch` and `lastSwitch` are protected from adapter merges.

## Pending switch (new key `transportMeta.pendingSwitch`)

Written by `POST /api/compactions` (with target fields) after the claim and the
queued-message check. Removed by `applyPendingSwitch`, by a stop (`stopSession` and the
dead-letter release), by an operator switch, and by a request that fails after writing it.

```ts
interface PendingSwitch {
  /** The self-compaction claim time; matched to the resume delivery's `sourceAttempt`. */
  claimedAt: number;
  from: SwitchTargetView;          // target when requested
  to: SwitchTargetView;            // validated target
  /** "same": model/effort only on an engine that compacts natively; "new": a new conversation. */
  conversation: "same" | "new";
  /** Whether a native compaction turn was queued before the resume (false: engine has none). */
  compactionQueued: boolean;
  handoff: CompactionHandoff;      // as compact_session's, already validated
  /** Set by the compaction settle hook. Absent when the resume starts = failed ("no-outcome"). */
  compaction?: { ok: true; summary: string } | { ok: false; reason: CompactionFailure };
}

type CompactionFailure =
  | "error" | "usage-limit" | "unconfirmed" | "no-summary" | "summary-too-long" | "no-outcome" | "not-supported";
// "not-supported": the engine has no native compaction, so none was queued.

interface SwitchTargetView {
  engine: string;
  profile: string | null;          // declared account name; null = own login (wire: "")
  claudeConfigDir: string | null;  // canonical dir, for apply
  model: string | null;
  effortLevel: string | null;
}
```

## Switch outcome (new key `transportMeta.lastSwitch`, informational)

Written by `applyPendingSwitch` and by the operator path, read by the notice and tests:
`{ at, by: "operator" | "session", from, to, applied: boolean, carryOver: "same-conversation" | "summary" | "manual-handover" | "transcript-pointer", reason?: string, leftTranscript?: string }`.
`leftTranscript` is the left Claude conversation's transcript path, computed before the
target write (unscoped sessions only).
`lastSwitch` replaces the previous value; history lives in the transcript notices.

## Switch notice (new message meta)

A `notification` message inserted with `meta.sessionSwitch = lastSwitch`. Text, e.g.:

- `🔀 Switched from Claude · own login · Opus to Claude · work · Sonnet (requested by this session; carried over by compaction summary)`
- `🔀 Switched … (requested by this session; the compaction failed (usage limit), so the new conversation was told where to read the history)`
- `🔀 Switch to OpenCode · x did not happen: the engine is no longer installed. Still on Claude · own login · Opus.`
- `🔀 Switched from Claude · own login · Opus to Claude · work · Opus (changed by the operator)`

## State transitions (tool path)

```
idle ──compact_session{target}──▶ claimed (selfCompactionAt) ──▶ pendingSwitch written
   ──▶ [compaction turn queued?] ──settle──▶ pendingSwitch.compaction recorded
   ──▶ resume turn starts ──applyPendingSwitch──▶ target applied | kept (invalid) ──▶ pendingSwitch removed, lastSwitch written, notice
stop before resume ──▶ queued resume withdrawn or dead-lettered ──▶ pendingSwitch removed (no switch)
operator switch before resume ──▶ pendingSwitch removed ──▶ resume runs as a plain resume
```
