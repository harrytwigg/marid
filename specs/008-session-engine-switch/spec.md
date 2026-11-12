# Feature Specification: Engine and Profile Switching for a Chat

**Feature Branch**: `spec/session-engine-switch`

**Created**: 2026-11-12

**Status**: Draft (clarified 2026-11-12; revised after spec review the same day)

**Input**: "In the web chat the operator can switch between engines but not between the
several Claude profiles (accounts) installed, and a session has no way to move itself to
another engine, profile or model. Add both: an engine and profile selector where the
model selector sits, usable at the start of a chat and mid-chat; and a session tool, in
the style of `compact_session`, that compacts the session and resumes it on a target the
caller names, with a way to list the valid targets."

## Problem

Three things a session runs on can differ between chats: the **engine** (Claude, OpenCode
and the others), the **Claude profile** (one of the accounts declared under
`engines.claude.accounts`, or the employee's own login when none is named), and the
**model** (with its effort level). Today:

- The composer's selector (`components/chat/model-selector-row.tsx`) lets the operator pick
  engine, model and effort in a new chat and change all three mid-chat. A profile can be
  picked only for a **new** chat; an existing chat shows its profile read-only, and only
  when it has one. The gateway refuses a profile change after creation
  (`PATCH /api/sessions/:id` rejects `engine: "claude:<name>"`; `sessions.claude_config_dir`
  is "chosen at creation only").
- A chat on the employee's own Claude login shows only the model name, so the operator
  cannot tell from the selector which account a chat is spending.
- A session can compact itself (`compact_session`: the engine's native compaction, then a
  resume turn carrying a handoff the session wrote), but it always resumes on the same
  engine, account and model. Moving a long-running session onto a cheaper model, onto
  another account with allowance left, or onto another engine needs the operator to do it
  by hand, and the session cannot be told "switch to profile X" and act on it.
- No session tool lists the engines, profiles and models a session could run on, so a
  model asked to switch has nothing to pick a valid target from.

Constitution, Principle II: this moves a decision from the operator to the system. A
session that knows its own allowance is running out, or that its remaining work is
routine, can move itself to where the capacity is.

## Glossary

- **Target**: the engine, Claude profile (Claude only) and model (with optional effort
  level) a session runs on.
- **Profile**: a Claude account declared under `engines.claude.accounts.<name>`. **Own
  login** means no profile: the session runs as its employee (or the gateway default) does.
- **Conversation**: the engine's own thread for a session on one engine and account. A
  Claude conversation can never be resumed on another profile; a conversation on one
  engine can never be resumed on another.
- **Switch**: changing a session's target. A switch that keeps the engine and account
  keeps the conversation; any other switch moves the session to another conversation.
- **Handoff**: the `goal / done / next / context / waitingOn` text a session writes for
  `compact_session`, with the same per-field caps.
- **Compaction summary**: the summary an engine's native compaction writes into the
  conversation it compacted.
- **History pointer**: a short instruction telling a new conversation where the session's
  earlier history can be read (the session's history in the gateway, and the left
  conversation's own log file when one exists on this host) and to read what it needs before
  carrying on. It never pastes the transcript itself: a model handed its own earlier
  conversation verbatim as a new message handles it badly.
- **Manual handover**: what a new conversation gets when the compaction of the conversation
  left behind did not produce a summary: the handoff and a history pointer.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See and change the chat's engine and profile from the composer (Priority: P1)

The operator opens a chat and sees, on the selector at the bottom, which engine, which
Claude profile (or own login) and which model it is configured with. They open the
selector, pick another profile (or engine) and send their next message, which runs there.

**Why this priority**: it is the operator's direct control, the smallest slice that
delivers the request, and the place the second part's results become visible.

**Independent Test**: on an instance with two declared Claude profiles, start a chat on
own login, switch it to the second profile mid-chat, send a message, and confirm the turn
ran on that account and the selector now names it.

**Acceptance Scenarios**:

1. **Given** a chat running on Claude with no profile, **When** the operator looks at the
   selector, **Then** it names the engine, "own login" (or the account's display name), and
   the model.
2. **Given** a new chat, **When** the operator picks a profile, an engine and a model,
   **Then** the chat is created on exactly that target (as today).
3. **Given** an existing idle chat on profile A, **When** the operator picks profile B,
   **Then** the selector shows B at once with "applies to your next message", and the next
   turn runs on B.
4. **Given** that switched chat, **When** the next turn runs on B, **Then** it is a new
   conversation for B, and the operator's message reaches it with a history pointer rather
   than a pasted transcript, with no extra turn.
5. **Given** a chat whose turn is running, waiting or queued, **When** the operator tries to
   change its engine or profile, **Then** the change is refused with the reason, as an
   engine switch is today.
6. **Given** a chat of a remote employee, **When** the operator opens the selector, **Then**
   no local profiles are offered.

---

### User Story 2 - A session switches itself on request (Priority: P1)

The operator tells a chat "switch to profile X" (or "move to Sonnet", or "carry on in
OpenCode"). The session writes a handoff and calls `compact_session` naming the target.
Its turn ends; the session resumes on the named target from its handoff and carries on.

The switch is an extension of `compact_session` (three optional target fields), not a new
tool: two new core tools would cost every session in the company about six times the
manifest tokens (plan.md, Constitution Check IV).

**Why this priority**: it is the second required part, and the one with no manual
workaround short of starting a new chat.

**Independent Test**: in a chat on profile A, ask the session to switch to profile B;
confirm the next turn runs on B, starts from the handoff, and the chat shows a switch
notice naming both targets.

**Acceptance Scenarios**:

1. **Given** a session on Claude own login, **When** it calls `compact_session` with a handoff
   and `profile: "B"`, **Then** the tool answers "scheduled", and after the current turn ends
   the session resumes on profile B with the handoff as its first message.
2. **Given** a session on Claude Opus, **When** it calls `compact_session` naming only another
   Claude model, **Then** the conversation is compacted with the engine's native compaction
   and the resume turn runs on the new model in the same conversation.
3. **Given** a session on Claude profile A, **When** it names profile B (or engine OpenCode
   and a model), **Then** the conversation on A is first compacted natively on A, and the
   session resumes on the target in a new conversation whose first message carries A's
   compaction summary and the handoff.
4. **Given** the same switch, **When** the compaction on A fails (A is out of allowance, the
   compaction turn errors, or it leaves no summary the gateway can read), **Then** the
   session still moves to the target, and its new conversation gets a manual handover: the
   handoff and a history pointer, no pasted transcript. The transcript notice says the
   compaction failed and a manual handover was used.
5. **Given** a target equal to the current one, **When** the call is made, **Then** it is
   refused and says to call `compact_session` without a target to compact in place.
6. **Given** a target that does not exist, is not installed, or is not available to this
   session, **When** the call is made, **Then** it is refused, nothing is scheduled, and the
   refusal carries the list of valid targets.
7. **Given** any refusal `compact_session` gives today (stopped session, terminal session,
   cooldown, messages already queued, unidentified caller, invalid handoff), **When** a call
   naming a target is made in the same state, **Then** it refuses the same way and schedules
   nothing.

---

### User Story 3 - A session learns where it can run (Priority: P2)

A session that names a target it cannot use (or asks with an engine name it knows is not
one, such as `"?"`) gets a refusal carrying its current target and every engine, profile
and model it may move to, and nothing is scheduled.

**Why this priority**: a switch is unusable without valid names. Carrying the list on the
refusal costs no manifest tokens; a separate read tool would tax every session and shrinks
no prompt.

**Independent Test**: call `compact_session` with `engine: "?"` from a session and compare
the refusal's list with the engines the instance has installed, its declared profiles and
each engine's models.

**Acceptance Scenarios**:

1. **Given** an unscoped local session, **When** it names an unknown target, **Then** it sees its
   current target, each installed engine with its models (and their effort levels), and each
   declared local Claude profile with whether its allowance is spent and when it resets.
2. **Given** a department-scoped session, **When** it names an unknown target, **Then** it sees Claude
   only, with every declared local profile.
3. **Given** any session, **When** it is given the list and then switches to one of them,
   **Then** the switch is not refused for being unknown or unavailable (barring config
   changing in between).

---

### User Story 4 - The operator sees what happened (Priority: P3)

After a switch by either path, the chat shows a notice naming the target left and the
target now in use, and the selector agrees with it.

**Independent Test**: perform each kind of switch and read the transcript and selector.

**Acceptance Scenarios**:

1. **Given** a session that switched itself, **When** the operator opens the chat, **Then**
   a notice in the transcript reads e.g. "Switched from Claude · own login · Opus to
   Claude · work · Sonnet (requested by this session)".
2. **Given** a scheduled switch that could not be applied, **When** the session resumes,
   **Then** it resumes on its old target with a notice saying why, and the resume message
   tells the session the switch did not happen.

### Edge Cases

- **Target spent.** The named profile or engine is known to be out of allowance: a switch is
  refused with the reset time, and the target list shows it as spent. The operator's selector
  still allows it (the operator may choose to wait).
- **Config changes in between.** The target was valid when scheduled and is gone when the
  switch applies (profile removed, engine uninstalled): the session stays on its current
  target, a notice says why, and the resume message says the switch did not happen.
- **Session stopped in between.** The operator stops the session after the tool answered:
  nothing runs, the switch is withdrawn with the compaction, as `compact_session` does today.
- **Fallback in force.** The session is running on a fallback stand-in because its own
  target hit a limit: a switch replaces the session's own target and ends the fallback run;
  the new target's own fallback chain applies from then on.
- **Parent waiting.** A delegated child switches itself mid-task: the turn that asked ends
  on a stopgap, which is not reported to the parent as the child's result (as
  `compact_session` does).
- **Return to a target left earlier.** A session switches A → B by the tool and later back
  to A: A starts a new conversation from the handoff rather than resuming the
  uncompacted conversation it left.
- **Engine without native compaction** (codex, grok and the others; OpenCode in run mode):
  a model-only switch on such an engine starts a new conversation from the handoff instead
  of refusing.
- **Remote employee.** Its session runs on its host's own login; a switch to a local profile
  is refused, as starting one there is today.
- **Department-scoped session** switching to another engine: refused (scoped sessions run
  only on Claude), as the operator's own engine switch is today. Switching between Claude
  profiles is allowed (FR-021), in either direction and back to own login.
- **Compaction turn hits a usage limit.** The compaction that precedes a switch never walks
  the leaving target's fallback chain: a limit there counts as a failed compaction and the
  switch goes ahead with a manual handover (FR-015b).
- **Compaction never settles.** If the compaction turn has not finished within the bound the
  plan sets, it counts as failed, and the switch goes ahead with a manual handover.
- **Two calls in one turn.** The second is refused by the shared cooldown.

## Clarifications

### Session 2026-11-12

- Q: When a session switches itself to another engine or profile, is the conversation it
  leaves natively compacted first? → A: Yes, on the old target (a Claude conversation can
  only be compacted by the account it belongs to). Detect whether that compaction failed; if
  it did, do a manual handover instead: the new conversation is told to read the old
  conversation's history.
- Q: May a department-scoped session switch itself to another Claude profile? → A: Yes, on
  any turn, to any declared local profile and back; switching between two profiles within
  one department must work. (An earlier reading that limited it to turns the operator's own
  message started was withdrawn by the operator.)
- Q: When the operator changes an existing chat's profile from the selector, what does the
  new conversation get? → A: No compaction and no extra turn.
- Q (raised by the operator): How does a new conversation learn what came before? → A: Never
  by piping the same transcript into it; tell it where the logs are and to read them
  (history pointer). Applies to every switch in this feature.

## Requirements *(mandatory)*

### Functional Requirements

**Composer selector (web)**

- **FR-001**: The selector MUST always show the chat's engine and model and, for Claude, its
  profile or "own login", in new and existing chats. On a narrow composer the effort level is
  dropped before the profile.
- **FR-002**: In a new chat the operator MUST be able to pick engine, profile and model
  (existing behaviour, kept).
- **FR-003**: In an existing chat the operator MUST be able to change the profile, as well as
  the engine, model and effort (the latter three exist today). "Own login" is a choice.
- **FR-004**: A profile or engine change in an existing chat applies from the next turn and is
  refused while a turn is running, waiting or queued, with the same message an engine change
  gets today.
- **FR-005**: The operator's profile change MUST obey the rules that govern starting a
  session on a profile: refused for a remote employee's session; allowed for the operator on
  a department-scoped employee's session.
- **FR-006**: After an operator's profile or engine change from the selector, the first turn
  on the new target starts a new conversation and carries the operator's message with a
  history pointer, not a pasted transcript. No compaction or extra turn runs. This replaces
  today's 20-message catch-up for selector engine changes too.
- **FR-007**: The conversation left behind by an operator's switch is kept, so switching back
  resumes it; what it missed meanwhile reaches it as a history pointer (from the time it last
  answered), not as pasted messages.

**Switch (session, through `compact_session`)**

- **FR-010**: `compact_session` MUST accept three optional target fields that let a session
  switch **its own** target: `engine` (default the current engine), `profile` (Claude only;
  a declared profile name, or `""` for own login; default the current profile when the
  engine stays Claude, own login when it becomes Claude) and `model` (default the model the
  session last used on that engine and account, else the engine's default). The handoff
  fields, required status and caps are unchanged. A call with none of the three is today's
  `compact_session`, unchanged. A call with any of them is a **switch**, and at least one
  must change the session's own target. The effort level after a switch is the one last
  used on the target, else the engine's default; the operator's selector can change it.
- **FR-011**: A switch MUST refuse, scheduling nothing, in every case `compact_session`
  refuses except "this engine has no native compaction" (a switch handles that, FR-014 and
  FR-015): a stopped session, a terminal session, an unidentified caller, an invalid handoff,
  the self-compaction cooldown (shared with `compact_session` and the operator's manual
  compaction), and messages already queued for the session. The tool description keeps
  saying it is never to be called from a Task sub-agent.
- **FR-012**: A switch MUST refuse a target that is unknown, not installed, equal to the
  session's own target, not allowed for this session (FR-020/FR-021), or known to be out of
  allowance (with its reset time when known). Each of these refusals names the problem and
  carries the target list (FR-030).
- **FR-013**: On success the tool answers "scheduled" and tells the caller to end its turn,
  as `compact_session` does. Nothing changes while the asking turn runs.
- **FR-014**: After the asking turn ends, a switch that keeps engine and account (a model or
  effort change only) runs the engine's native compaction and then the resume turn on the
  new model, in the same conversation. Where the engine has no native compaction Jinn can
  drive, it starts a new conversation from the handoff instead.
- **FR-015**: After the asking turn ends, a switch to another engine or profile first runs the
  native compaction on the conversation being left, on the target being left (engine,
  account and model unchanged). Engines without a native compaction Jinn can drive skip
  this step and go straight to FR-015b.
- **FR-015a**: When that compaction succeeds (it finishes and its summary can be read back),
  the session moves to the target and the resume turn runs there in a new conversation whose
  first message carries the compaction summary, then the handoff.
- **FR-015b**: When it fails (an error, a usage limit, a stop of the compaction turn alone,
  no summary that can be read back, or no finish within the plan's bound), the session still
  moves to the target and the resume turn carries a manual handover: the handoff and a
  history pointer giving the exact way to read the earlier history, no pasted transcript.
  The compaction turn never walks a fallback chain.
- **FR-015c**: Which path ran (summary or manual handover, and why) is recorded on the
  session and shown in the switch notice.
- **FR-016**: The resume message MUST name the target the session now runs on and carry the
  handoff verbatim, with the same "resume from Next" instruction `compact_session` gives.
- **FR-017**: The switch MUST persist: every later turn uses the new target, the new target's
  fallback chain applies, and any fallback run or stand-in in force on the old target ends.
- **FR-018**: A conversation left by a session's own switch is retired: a later return to that engine
  and account starts a new conversation.
- **FR-019**: The scheduled switch MUST survive a gateway restart between the tool call and
  the resume (it is delivered durably, as the `compact_session` resume is). If the target is
  no longer valid when the switch applies, the session stays on its current target and the
  resume message and a transcript notice both say so.

**Who may switch to what**

- **FR-020**: A session MAY switch only to targets it could be started on: engines installed
  on its host, Claude profiles declared for its host, models the engine offers. A remote
  employee's session may not switch to a local profile.
- **FR-021**: A department-scoped session MUST NOT switch to another engine (scoped sessions
  run only on Claude). It MAY switch to any declared local Claude profile, or back to own
  login, on any turn, so two profiles used within one department can be switched between in
  both directions. (This relaxes, for switching only, today's rule that a scoped session may
  not start a session on a profile; that spawn rule is unchanged.)
- **FR-022**: A switch changes only the caller's own session. No session id is accepted;
  one sent in the body is ignored.

**Target list (on refusal)**

- **FR-030**: Every target refusal (FR-012) MUST carry, for the calling session: its own
  current target; each engine it may switch to with its models (id, label, context window
  where known) and default model; and each Claude profile it may switch to, with whether its
  allowance is spent and when it resets, where known.
- **FR-031**: The list MUST show exactly what FR-020/FR-021 allow for this caller. A caller
  that may not use profiles (a remote employee's session) is not told which exist.
- **FR-032**: A target refusal takes no cooldown claim and is checked before the handoff, so
  a session can ask for the list (e.g. `engine: "?"`) without a handoff and as often as it
  needs.

**Visibility**

- **FR-040**: Every switch, by the operator or by a session, MUST add a transcript notice
  naming the old and new target and who asked; a failed scheduled switch adds a notice saying
  why.
- **FR-041**: The selector MUST reflect the new target as soon as the switch is applied,
  without a reload.

### Key Entities

- **Session target**: engine, Claude profile (or own login), model, effort level. Already
  stored on the session (`engine`, `claudeConfigDir`, `model`, `effortLevel`); the profile
  becomes changeable after creation.
- **Conversation slot**: the session's per-engine, per-account conversation id, already kept
  so a session can return to an engine it left. A tool switch retires the slot it leaves.
- **Scheduled switch**: the target and handoff recorded when the tool is called, applied after
  the asking turn ends; its claim is the self-compaction cooldown claim. Records which
  carry-over path ran (compaction summary or manual handover) and why.
- **Switch notice**: a transcript entry naming old target, new target and requester.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every chat, the operator can read engine, profile (or own login) and model
  from the selector without opening it.
- **SC-002**: The operator can move an idle chat to another profile in three interactions or
  fewer (open selector, pick profile, send), and the next turn runs on that account in 100%
  of trials.
- **SC-003**: A session asked "switch to profile X" (with X declared and allowed) resumes on
  X from its handoff with no further operator action, and the transcript shows the switch.
- **SC-004**: Every refusal case in FR-011, FR-012 and FR-021 schedules nothing: the session's
  target, conversation and queue are unchanged afterwards.
- **SC-005**: Every target a refusal lists is accepted by a switch when nothing
  else has changed.
- **SC-006**: Instances with no declared profiles see no change to the selector other than
  the engine name and "own login" label (FR-001).
- **SC-007**: A cross-engine or cross-profile switch whose compaction fails still lands on the
  target in 100% of trials, with a manual handover and a notice saying so.
- **SC-008**: No switch in this feature puts the earlier conversation's messages into the new
  conversation's first message; each carries a history pointer (or a compaction summary
  and handoff) instead.

## Assumptions

- "Profile" is a Claude-only idea. OpenCode providers are reached through model ids
  (`provider/model`), as in fallback chains; there are no OpenCode profiles.
- The sub-agent rule for a switch is the same as `compact_session`'s: stated in the
  tool description, not enforced by the gateway, because a Task sub-agent shares its
  session's identity.
- Switching changes one session only. It never changes the employee's own configured engine,
  model or account.
- The operator's selector does not ask the session to write a handoff; the operator's switch
  is immediate (clarified 2026-11-12).
- A switch to a spent target is refused for a session (FR-012) but allowed for the operator,
  who may choose to wait for the reset.
- Remote declared profiles (`remoteHost`) are fallback targets for remote employees only and
  are not offered by the selector or the tools in this feature.
- Fallback-chain hops (a usage limit moving a turn to a stand-in) keep their current
  catch-up; changing them to history pointers is a separate change.
- The history pointer names a way the new conversation can actually use: the gateway's
  session history through `read_session` on its own id, plus the left conversation's log
  file path on this host when there is one. A department-scoped session gets `read_session`
  only, since its department may not read files outside its stage.
- The three target fields grow the MCP tool manifest by 28 tokens on its largest wrapper
  (measured: Pi 4,371 → 4,399, against a ceiling of 4,371; plan.md Constitution Check IV).
  The ceiling is rebased by what is left after any dead prose is bought back.

## Out of Scope

- Switching another session (a parent switching its child, the operator asking one chat to
  switch another).
- Changing an employee's configured engine, model or account.
- New engines, new accounts, or account sign-in from the selector.
- Remote-host profile switching.
- Scheduling switches automatically (e.g. at a capacity threshold); this feature gives a
  session the tool, and a later feature may decide when it is used.
