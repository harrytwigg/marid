# Quickstart: verifying engine and profile switching

A functional run on an isolated sandbox (own port, own home, test credentials). Never point
it at a real instance.

## Setup

1. Build and create a sandbox: `scripts/jinn-sandbox.sh create <name> --port <free port> --build --seed`.
2. Declare two Claude profiles under `engines.claude.accounts` (`alpha`, `beta`), each a
   scratch config dir; point `engines.claude.bin` at `scripts/fake-providers/fake-claude.mjs`.
   It does not model compaction today; Part B extends it to answer `/compact` with a
   `PostCompact` hook, a `compact_boundary` transcript entry and a summary entry, and to
   fail a compaction on a rate-limited profile (task T030).
3. Enable the opencode fake in server mode for the cross-engine case.

## Operator path (US1)

1. New chat on own login. Chip reads `Claude · Own login · <model>`.
2. Send a message; pick profile `beta` mid-chat. Chip shows `beta` with "Applies to your next message".
3. Send a message. Expect: the fake ran under `beta`'s config dir; the first prompt it got
   contains the history pointer (`read_session`) and **no** earlier message text; a switch
   notice "changed by the operator".
4. Switch back to own login: the parked conversation resumes; prompt carries a pointer from
   the time it last answered.
5. While a turn runs, try to switch: refused with the existing wording.
6. Remote employee's chat: no profile rows.

## Tool path (US2, US3)

1. In a chat on own login, ask the session to call `compact_session` with `engine: "?"` and a
   handoff: refused 400 `invalid-target`, nothing scheduled, `targets` lists own login,
   `alpha`, `beta` and opencode with models.
2. Ask it to call `compact_session` with `profile: "alpha"` and a handoff. Expect 202, a `/compact` turn on own
   login, then the resume on `alpha` in a new conversation whose first message holds the
   fake's summary, then the handoff; notice "carried over by compaction summary".
3. Make the fake rate-limit own login, repeat: compaction fails (usage limit), the session
   still lands on `alpha`, resume holds handoff + pointer, notice says manual handover.
4. Model-only switch (Opus → Sonnet): compaction in place, same conversation, model changed.
5. Switch to opencode: compaction on Claude, resume on opencode.
6. Refusals: same target (400 same-target), unknown profile (400), exhausted `beta` (409),
   message queued (409), second call within 10 min (429), stop between call and resume
   (no switch, claim released).
7. Stop between the call and the resume; then type `/compact` as the operator: no switch, and
   the operator's compaction is not recorded against a stale pending switch.
8. Switch the chat from the selector after the call but before the resume: the operator's
   target stands; the resume runs as a plain resume.
9. Department-scoped employee's session: switch `alpha` ↔ `beta` on an ordinary turn works;
   to opencode refused (403).
10. Remove `alpha` from config between the call and the resume: resume on the old target with
   "did not happen".

## Evidence for the PR

Screenshots of the chip (own login, profile, narrow composer) before and after; the
transcript notices; the fake's recorded prompts showing pointer vs summary.
