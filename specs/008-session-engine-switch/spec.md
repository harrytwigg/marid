# Feature Specification: Engine and Profile Switching for a Chat

**Feature Branch**: `spec/session-engine-switch`

**Created**: 2026-11-12

**Status**: Draft (clarification pending)

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
   conversation for B and it is given the recent transcript so it can continue
   [NEEDS CLARIFICATION: Q3 — transcript catch-up as an engine switch does today, or a
   compaction with a handoff first?].
5. **Given** a chat whose turn is running, waiting or queued, **When** the operator tries to
   change its engine or profile, **Then** the change is refused with the reason, as an
   engine switch is today.
6. **Given** a chat of a remote employee, **When** the operator opens the selector, **Then**
   no local profiles are offered.

---

### User Story 2 - A session switches itself on request (Priority: P1)

The operator tells a chat "switch to profile X" (or "move to Sonnet", or "carry on in
OpenCode"). The session lists the valid targets, writes a handoff, and calls the switch
tool. Its turn ends; the session resumes on the named target from its handoff and carries
on.

**Why this priority**: it is the second required part, and the one with no manual
workaround short of starting a new chat.

**Independent Test**: in a chat on profile A, ask the session to switch to profile B;
confirm the next turn runs on B, starts from the handoff, and the chat shows a switch
notice naming both targets.

**Acceptance Scenarios**:

1. **Given** a session on Claude own login, **When** it calls the switch tool with a handoff
   and profile B, **Then** the tool answers "scheduled", and after the current turn ends
   the session resumes on profile B with the handoff as its first message.
2. **Given** a session on Claude Opus, **When** it calls the switch tool naming only another
   Claude model, **Then** the conversation is compacted with the engine's native compaction
   and the resume turn runs on the new model in the same conversation.
3. **Given** a session on Claude, **When** it names engine OpenCode and a model, **Then** it
   resumes on OpenCode with that model, in a new conversation started from the handoff
   [NEEDS CLARIFICATION: Q1 — does a switch to another engine or profile first run the
   native compaction on the conversation being left?].
4. **Given** a target equal to the current one, **When** the tool is called, **Then** it is
   refused and points at `compact_session`.
5. **Given** a target that does not exist, is not installed, or is not available to this
   session, **When** the tool is called, **Then** it is refused, nothing is scheduled, and
   the refusal names the valid choices or says to list them.
6. **Given** any refusal `compact_session` gives (stopped session, terminal session,
   cooldown, messages already queued, unidentified caller, invalid handoff), **When** the
   switch tool is called in the same state, **Then** it refuses the same way and schedules
   nothing.

---

### User Story 3 - A session lists where it can run (Priority: P2)

Before switching, the session asks what it can switch to and gets its current target and
every engine, profile and model it may move to.

**Why this priority**: the switch tool is unusable without valid names, but the list is
small and read-only.

**Independent Test**: call the list tool from a session and compare it with the engines the
instance has installed, its declared profiles and each engine's models.

**Acceptance Scenarios**:

1. **Given** an unscoped local session, **When** it lists targets, **Then** it sees its
   current target, each installed engine with its models (and their effort levels), and each
   declared local Claude profile with whether its allowance is spent and when it resets.
2. **Given** a department-scoped session, **When** it lists targets, **Then** it sees only
   what it could switch to (see FR-021) and no profile it may not use.
3. **Given** any session, **When** it lists targets and then switches to one of them,
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

- **Target spent.** The named profile or engine is known to be out of allowance: the switch
  tool refuses with the reset time, and the list shows it as spent. The operator's selector
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
  only on Claude), as the operator's own engine switch is today.
- **Two calls in one turn.** The second is refused by the shared cooldown.

## Clarifications

### Session 2026-11-12

_Pending: questions Q1–Q3 are with the operator._

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
  a department-scoped employee's session (only the operator may move such a session).
- **FR-006**: After an operator's profile change, the first turn on the new profile starts a
  new conversation and is brought up to date with the recent transcript, exactly as the first
  turn after an engine change is today. [NEEDS CLARIFICATION: Q3]
- **FR-007**: The conversation left behind by an operator's switch is kept, so switching back
  resumes it with what it missed (today's engine-switch behaviour, extended to profiles).

**Switch tool (session)**

- **FR-010**: A new session tool MUST let a session switch **its own** target. It takes a
  handoff (the `compact_session` fields, required/optional status and caps unchanged) and a
  target: `engine` (optional, default the current engine), `profile` (Claude only; a
  declared profile name, or own login), `model` (optional, default the target engine's
  default model, or the model the session last used there) and `effortLevel` (optional). At
  least one of them must change the current target.
- **FR-011**: The tool MUST refuse, scheduling nothing, in every case `compact_session`
  refuses: a stopped session, a terminal session, an unidentified caller, an invalid handoff,
  the self-compaction cooldown (shared with `compact_session` and the operator's manual
  compaction), and messages already queued for the session. Its description says, as
  `compact_session`'s does, that it is never to be called from a Task sub-agent.
- **FR-012**: The tool MUST refuse a target that is unknown, not installed, equal to the
  current target, not allowed for this session (FR-020/FR-021), or known to be out of
  allowance (with its reset time when known). Each refusal names the problem and points at
  the list tool.
- **FR-013**: On success the tool answers "scheduled" and tells the caller to end its turn,
  as `compact_session` does. Nothing changes while the asking turn runs.
- **FR-014**: After the asking turn ends, a switch that keeps engine and account (a model or
  effort change only) runs the engine's native compaction and then the resume turn on the
  new model, in the same conversation. Where the engine has no native compaction Jinn can
  drive, it starts a new conversation from the handoff instead.
- **FR-015**: After the asking turn ends, a switch to another engine or profile moves the
  session to the target and runs the resume turn there, in a new conversation whose first
  message is the handoff. [NEEDS CLARIFICATION: Q1 — whether the native compaction runs
  first on the conversation being left]
- **FR-016**: The resume message MUST name the target the session now runs on and carry the
  handoff verbatim, with the same "resume from Next" instruction `compact_session` gives.
- **FR-017**: The switch MUST persist: every later turn uses the new target, the new target's
  fallback chain applies, and any fallback run or stand-in in force on the old target ends.
- **FR-018**: A conversation left by a tool switch is retired: a later return to that engine
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
  run only on Claude). Whether it may switch to another Claude profile:
  [NEEDS CLARIFICATION: Q2].
- **FR-022**: The tool switches only the caller's own session. The target is never another
  session's id.

**List tool (session)**

- **FR-030**: A session tool MUST list, for the calling session: its current target; each
  engine it may switch to with its models (id, label, effort levels, context window where
  known) and default model; and each Claude profile it may switch to, with whether its
  allowance is spent and when it resets, where known.
- **FR-031**: The list MUST show exactly what FR-020/FR-021 allow for this caller. A caller
  that may not use profiles is not told which exist.
- **FR-032**: The list is read-only and has no cooldown.

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
  the asking turn ends; its claim is the self-compaction cooldown claim.
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
- **SC-005**: Every target the list tool returns is accepted by the switch tool when nothing
  else has changed.
- **SC-006**: Instances with no declared profiles see no change to the selector other than
  the engine name and "own login" label (FR-001).

## Assumptions

- "Profile" is a Claude-only idea. OpenCode providers are reached through model ids
  (`provider/model`), as in fallback chains; there are no OpenCode profiles.
- The sub-agent rule for the switch tool is the same as `compact_session`'s: stated in the
  tool description, not enforced by the gateway, because a Task sub-agent shares its
  session's identity.
- Switching changes one session only. It never changes the employee's own configured engine,
  model or account.
- The operator's selector does not ask the session to write a handoff; the operator's switch
  is immediate (see Q3 for the alternative).
- A switch to a spent target is refused for a session (FR-012) but allowed for the operator,
  who may choose to wait for the reset.
- Remote declared profiles (`remoteHost`) are fallback targets for remote employees only and
  are not offered by the selector or the tools in this feature.
- Adding two session tools grows the MCP tool manifest; its budget is rebased as part of the
  work.

## Out of Scope

- Switching another session (a parent switching its child, the operator asking one chat to
  switch another).
- Changing an employee's configured engine, model or account.
- New engines, new accounts, or account sign-in from the selector.
- Remote-host profile switching.
- Scheduling switches automatically (e.g. at a capacity threshold); this feature gives a
  session the tool, and a later feature may decide when it is used.
