# Board hooks

Board hooks are configurable, asynchronous reactions to Todo board events. When a
Todo is created, changes status, is assigned, delegated, dispatched or commented on,
every enabled hook whose matcher fits runs its actions: spawn a session for a named
employee, run a command, and/or post a connector message. Each firing is recorded in
a run log that the dashboard's **Hooks** page shows.

Not to be confused with `gateway/hook-registry.ts` / `hook-endpoint.ts`, which relay
Claude Code's own tool hooks (SessionStart, Stop, ...). Board hook code lives in
`packages/jinn/src/board-hooks/` and its tables are prefixed `board_hook_`.

## Guarantees

- **Fire-and-forget.** A board write never waits on a hook. Events are taken off the
  write path on `setImmediate`, after the write has returned. There is no hook
  timeout: a command that hangs stays `running` in the log until it exits or the
  gateway stops. Commands run in their own process group, which a graceful gateway
  stop terminates; after a hard kill they keep running, and their rows are marked
  `interrupted` at the next start.
- **Failures never touch the move.** Any error inside matching, payload building or an
  action is caught and recorded on the run row. Nothing is retried.
- **Committed writes only.** An event is dispatched only if its `work_item_events` row
  still exists when the queue drains, so a write rolled back by an enclosing
  transaction fires nothing.
- **Loop guard.** A board event caused by a session that a hook spawned (or by any
  descendant of one) does not fire any hook already in that session's hook chain,
  unless the hook sets `allowReentry: true`. Chains are capped at `MAX_HOOK_CHAIN`
  (5) hooks even with re-entry allowed.
- **Hot reload.** Hooks are read from the live config on every event, so an edit to
  `config.yaml` applies to the next event with no restart.

## Configuration

```yaml
hooks:
  - name: review-merge            # unique, [a-z0-9-]+, max 64 chars
    enabled: true                 # default true
    event: todo.status_changed    # one event or a list
    match:                        # every field optional; fields AND together,
      from: executing             #   a list inside one field is any-of
      to: in_review
      department: platform
      label: auto-merge           # the Todo carries (any of) these labels
      assignee: senior-developer  # current assignee; "operator" matches the operator
      actor: [operator, employee] # operator | system | employee | <employee slug>
      reviewAddressee: operator   # operator | employee: who the Todo's review is addressed to
    allowReentry: false           # default false; see "Loop guard"
    action:                       # at least one of spawn / command / notify
      spawn:
        employee: merger
        prompt: "{{todo.id}} moved {{from}} -> {{to}}. Merge {{prUrl}} if green."
        effortLevel: medium       # optional; also engine, model
      command:
        run: ./scripts/on-review.sh   # run with /bin/sh -c
        cwd: /srv/work                # optional; default the instance home
      notify:
        connector: telegram
        channel: "123456"
        thread: null                  # optional
        text: "{{todo.id}} is waiting on you: {{todo.title}}"
```

A malformed hook never stops `config.yaml` from loading and never takes the other
hooks down: it is skipped, logged once as a warning, and listed in the `problems` of
`GET /api/hooks`. `PUT /api/config` does not reject it either.

### Events

| Event | Fires when | Source row (`work_item_events.kind`) |
|---|---|---|
| `todo.created` | a Todo is created | `created` |
| `todo.status_changed` | its status changes | `status_change`, `escalated` (when it carries a `to_status`) |
| `todo.assigned` | its assignee changes after creation | `note` with `detail.assignee`, or `metadata_edited` whose `detail.updatedFields` includes `assignee` |
| `todo.delegated` | a session is delegated onto it | `session_linked` with `detail.via: "delegation"` |
| `todo.dispatched` | the dispatcher or board walk starts it | `session_linked` with `detail.via: "dispatch"` |
| `todo.commented` | a comment is added | `comment_added` |

`session_linked` rows without `detail.via` (older rows, other link paths) fire nothing.

### Templates

`{{path}}` is replaced by the payload value at that dotted path (`{{todo.title}}`,
`{{to}}`, `{{actor.employee}}`). Objects and arrays render as JSON; a missing path
renders as an empty string. There is no logic. `{{payload}}` renders the whole payload
as JSON. A spawn prompt always ends with the full payload in a fenced `json` block,
whatever the template says. A spawn with no `prompt` uses a default that names the
hook and the event.

## Example: review, merge and close

A hook on `to: in_review` with a label can start a reviewer that checks the Todo's
pull request, merges and deploys it, and closes the Todo. The reviewer is an employee
whose YAML says `closeTodos: true` (see "Closing Todos" in the org docs); without that
grant its `update_work_item { status: "done" }` is refused like any other employee's. Even
with it, a close is accepted only from `in_review`: a Todo in any other open status is
refused until it has been moved there.

```yaml
# employee: org/ops/release-reviewer.yaml
name: release-reviewer
displayName: Release Reviewer
department: ops
rank: senior
persona: >
  You review a finished Todo's pull request. If the checks are green and the
  change does what the Todo asks, merge it and deploy it. Then close the Todo.
  If anything is wrong, say what in a comment and leave the Todo where it is.
closeTodos: true
```

```yaml
# config.yaml
hooks:
  - name: review-merge-close
    event: todo.status_changed
    match:
      to: in_review
      label: auto-close
    action:
      spawn:
        employee: release-reviewer
        prompt: >
          {{todo.id}} moved {{from}} -> {{to}}. Check {{prUrl}}: CI green and the
          change matches the Todo. If so, merge it, deploy it, and close the Todo
          with update_work_item { id: "{{todo.id}}", status: "done", note: "<what
          you merged and deployed>" }. Otherwise comment with what is wrong.
```

The reason in `note` is required and is posted on the Todo as `Closed as done by
release-reviewer. Reason: …`.

## Payload

```jsonc
{
  "version": 1,
  "fireId": "bhf_…",               // one per (event, hook)
  "hook": "review-merge",
  "event": "todo.status_changed",
  "eventId": "wie_…",              // the work_item_events row
  "at": "2026-01-01T12:00:00.000Z",// the event row's created_at
  "todo": {
    "id": "ACM-12", "title": "…", "status": "in_review", "department": "platform",
    "labels": ["auto-merge"], "assignee": "senior-developer",
    "parentId": null, "rootId": "ACM-12", "childIds": ["ACM-13"],
    "reviewAddressee": { "kind": "operator" },  // or { "kind": "employee", "employee": "…" }
    "url": "/todos/ACM-12"
  },
  "from": "executing",             // status events only, else null
  "to": "in_review",
  "actor": {
    "raw": "session:…",            // as recorded on the event row
    "kind": "employee",            // operator | employee | system
    "employee": "senior-developer",// when known
    "sessionId": "…"               // when the actor was a session
  },
  "text": "…",                     // the comment body, or the note on the event; else null
  "prUrl": "https://github.com/o/r/pull/1", // first PR link found, else null
  "sessionId": "…",                // delegated/dispatched: the linked session
  "chain": ["review-merge"]        // hooks upstream of this event, oldest first, then this hook
}
```

`todo.reviewAddressee` says who the Todo's `in_review` is addressed to: the parent's owner
(`{ "kind": "employee", "employee": … }`) when the Todo has a parent owned by an employee
in the org and that parent is not closed, otherwise the operator. It is computed when the
event fires. A hook meant for the operator's desk can add `match: { reviewAddressee: operator }`
to skip reviews that belong to a parent's owner; a hook without the field fires as before.

`prUrl` is the first GitHub pull-request URL found in, in order: the event's text,
the Todo's latest 20 comments (newest first), the Todo body.

`actor` is who made the write. For a comment it is the comment's author and
authoring session. For `todo.created` the event row records only the source kind
(`human`, `session`, `delegation`, …), so the creator comes from the Todo itself:
`operator` for an operator's Todo, otherwise the creating session named in its
`sourceRef` (`session:<id>:…`, `delegate:<id>:…`) and that session's employee. A
`todo.dispatched` actor is whoever asked for the start (`operator`, the session, or
`board-walk`). A session with no employee, and every other source, is `system`.

## Loop guard

A hook's `spawn` action starts its session with provenance `source: "hook"`,
`sourceRef: "hook:<fireId>"`. The run row for that fire records the chain:
the event's upstream chain plus this hook (the same value as `payload.chain` and
`JINN_HOOK_CHAIN`).

When an event's actor resolves to a session (see `actor` above), the dispatcher walks that session and its
`parentSessionId` ancestors (at most 10 levels). Every ancestor with `source: "hook"`
contributes the chain stored on its run row; the union is the event's upstream chain.
`from`/`to` are null on non-status events, and a `from`/`to` matcher never matches them.

A hook whose name is in the chain is skipped unless `allowReentry` is set, and every
hook is skipped once the chain holds `MAX_HOOK_CHAIN` names. Skips are logged as
`suppressed` runs so a hook that "did not fire" can be explained.

A close made by a `closeTodos` employee fires `todo.status_changed` with `from:
in_review`, `to: done`, which a hook matching `to: in_review` does not match, so the
example above does not trigger itself. A hook that matches `to: done` does fire on it,
with the closing employee as the actor.

Limits: a `command` action's own API calls carry no session, so they are not
chain-tracked; its environment carries `JINN_HOOK_CHAIN` for scripts that want to
guard themselves. Moves the gateway derives on its own (the reconciler, park expiry)
carry no session either, even when a hook session's work caused them. `notify`
cannot write to the board. Nothing caps how many hooks fire at once: a cascade that
closes many Todos fires a hook for each.

## Actions

- **spawn**: `spawnSession` in-process with the rendered prompt, the configured
  employee/engine/model/effortLevel, no parent session (a hook session's callback
  must not wake the actor's session), and hook provenance. Run outcome: `ok` with
  the session id, or `error`.
- **command**: `/bin/sh -c <run>`, payload JSON on stdin; environment is the
  scrubbed child env plus `JINN_HOOK_NAME`, `JINN_HOOK_EVENT`, `JINN_HOOK_FIRE_ID`,
  `JINN_HOOK_TODO_ID`, `JINN_HOOK_FROM`, `JINN_HOOK_TO`, `JINN_HOOK_ACTOR`,
  `JINN_HOOK_CHAIN` (comma-separated) and `JINN_HOOK_PAYLOAD` (the JSON, omitted when
  it is over 64 KB; stdin always carries it). The command
  passes the gateway's command policy first; a refused command is an `error` run.
  Outcome: `ok` on exit 0, `error` otherwise, with the exit code and the redacted
  last 4 KB of stdout+stderr.
- **notify**: the configured connector's `sendMessage`, text rendered and redacted.

Each action of a firing is its own run row, so a hook with `spawn` and `notify`
writes two rows sharing one `fireId`. A hook whose payload could not be built is
logged as an `error` run with action `none`.

## Run log

Table `board_hook_runs` in the gateway database:

| column | |
|---|---|
| `id` | `bhr_…` |
| `fire_id` | shared by the actions of one firing |
| `hook`, `event`, `event_id`, `todo_id` | what fired, on what |
| `action` | `spawn` / `command` / `notify` / `none` (suppressed) |
| `status` | `running` / `ok` / `error` / `suppressed` / `interrupted` |
| `session_id`, `exit_code`, `error`, `output` | outcome |
| `payload`, `chain` | JSON |
| `started_at`, `finished_at`, `started_ms` | |

Retention: rows older than 30 days, and rows beyond the newest 10,000, are pruned at
most once an hour, at write time; `running` rows are never pruned. A hook session
whose run row has been pruned is no longer loop-guarded (a warning is logged). At gateway start, rows still `running` from a
previous process are marked `interrupted`.

## API (operator only)

- `GET /api/hooks` → `{ hooks: [{ name, enabled, events, match, actions, allowReentry, lastFiredAt, lastStatus }], problems: string[] }`.
  `actions` summarises each action (`{ kind: "spawn", employee }`, `{ kind: "command", run }`, `{ kind: "notify", connector, channel }`).
- `GET /api/hooks/runs?hook=&status=&todo=&limit=&before=` → `{ runs: HookRun[], nextBefore: string | null }`,
  newest first, `limit` default 50, max 200, `before` a run id cursor. List rows omit `payload` and `output`.
- `GET /api/hooks/runs/:id` → `{ run: HookRun }` with `payload` and `output`.
- `POST /api/hooks/:name/enabled` `{ enabled: boolean }` → `{ ok: true }`. Edits that hook's
  `enabled` key in `config.yaml` in place (comments preserved) and reloads config.

The gateway broadcasts `hooks:run` `{ id, hook, status }` whenever a run row is
written or finished; the web client refetches on it.

## Out of scope for the first cut

- Creating or editing hooks from the dashboard: `config.yaml` is the source; the page
  can only toggle `enabled`.
- Time-based events (a Todo sitting in a status for N hours).
- Retries.
