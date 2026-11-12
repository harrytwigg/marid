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

Keyed by `threadSlot`: the engine name, or for Claude the account key (`claude` for own
login, `claude:<profile key>` otherwise). `switchSessionTarget` with
`leftConversation: "park"` (operator) keeps the left slot so a return resumes it;
`"retire"` (tool) deletes it so a return starts fresh (FR-018).

## Sync marker (existing keys in `transportMeta`, one added)

| Key | Meaning |
|---|---|
| `engineSyncTarget`, `engineSyncSince` | existing: the new slot owes a catch-up from this time |
| `engineSyncMode` | **new**: `"pointer"` (history pointer, written by `switchSessionTarget`) or absent/`"transcript"` (today's pasted catch-up, every other writer) |

Cleared on a clean settle by `withSyncMarkersCleared`, which must clear `engineSyncMode` too.

## Pending switch (new key `transportMeta.pendingSwitch`)

Written by `POST /api/session-switches` after the claim and the queued-message check;
removed by `applyPendingSwitch`, or by the stop path that dead-letters the resume.

```ts
interface PendingSwitch {
  /** The self-compaction claim time; also the resume delivery's `meta.switchResume`. */
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
  | "error" | "usage-limit" | "stopped" | "unconfirmed" | "no-summary" | "no-outcome" | "not-supported";

interface SwitchTargetView {
  engine: string;
  profile: string | null;          // declared account name; null = own login
  claudeConfigDir: string | null;  // canonical dir, for apply
  model: string | null;
  effortLevel: string | null;
}
```

## Switch outcome (new key `transportMeta.lastSwitch`, informational)

Written by `applyPendingSwitch` and by the operator path, read by the notice and tests:
`{ at, by: "operator" | "session", from, to, applied: boolean, carryOver: "same-conversation" | "summary" | "manual-handover" | "transcript-pointer", reason?: string }`.
`lastSwitch` replaces the previous value; history lives in the transcript notices.

## Switch notice (new message meta)

A `notification` message inserted with `meta.sessionSwitch = lastSwitch`. Text, e.g.:

- `🔀 Switched from Claude · own login · Opus to Claude · work · Sonnet (requested by this session; carried over by compaction summary)`
- `🔀 Switched … (requested by this session; the compaction failed (usage limit), so the new conversation was told where to read the history)`
- `🔀 Switch to OpenCode · x did not happen: the engine is no longer installed. Still on Claude · own login · Opus.`
- `🔀 Switched from Claude · own login · Opus to Claude · work · Opus (changed by the operator)`

## State transitions (tool path)

```
idle ──switch_session──▶ claimed (selfCompactionAt) ──▶ pendingSwitch written
   ──▶ [compaction turn queued?] ──settle──▶ pendingSwitch.compaction recorded
   ──▶ resume turn starts ──applyPendingSwitch──▶ target applied | kept (invalid) ──▶ pendingSwitch removed, lastSwitch written, notice
stop before resume ──▶ resume dead-lettered ──▶ claim released, pendingSwitch removed (no switch)
```
