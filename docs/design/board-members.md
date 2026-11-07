# Board members: user accounts, sign-in and shared boards

Status: design, phased build. Applies to the gateway (`packages/jinn`) and the web UI (`packages/web`).

## Problem

An instance has exactly one human: the operator. Every authenticated browser is the
operator (a paired device in `auth-devices.json`), and attribution on Todos, comments and
events is either `operator` or an employee. There is no way to let a second person see one
board, and no way to tell two people apart.

## Goals

- Real per-person accounts with a sign-in screen (email and password), managed from a
  People page.
- The operator invites a person to **one board** with an explicit role. The person accepts,
  sets their own password, and sees that board and nothing else.
- What a person creates or says is attributed to them by name, with an avatar that is
  visibly a human, distinct from agents and from the operator.
- Revoking access takes effect on the next request, without a restart.
- An instance that never creates an account behaves exactly as today.

## Non-goals (v1)

- Sending email. An invite is a link the inviter copies and delivers. Mail delivery is a
  later, optional transport behind the same invite record.
- Members spending money: a member cannot dispatch, assign employees, start agents, or wake
  anyone with an `@mention`. Their Todos are created unassigned and never auto-started.
- Assigning a Todo to a human **as its agent**. A person is shown as the creator and last toucher of a Todo, and may be
  named as the person responsible beside the agent ("Person and agent assignees" below); that label starts nothing.
- Multiple tenants. One instance, many boards, many people; a person may belong to several
  boards.
- Passkeys and SSO. The account model leaves room for both.

## Vocabulary

- **Board**: a department's Todo board. A Todo belongs to the board of its **root's**
  department (the same rule the department scope uses). Todos with no department (the
  company board) cannot be shared in v1.
- **Operator**: today's principal. Unchanged.
- **User**: a person with an account (`users` row).
- **Member**: a user acting through a user session. A member's authority is exactly the
  union of their board grants.
- **Instance owner**: a user flagged as the operator. Signing in as one yields an ordinary
  operator device session, so the operator can use the same sign-in screen instead of a
  pairing code.

## Identity model

All new state lives in **new, additive tables** in the registry database, registered the
way earlier additive tables were (created when missing, shape-verified at boot). No existing
table changes shape, so an older build ignores them and a rollback stays bootable.

```
users(
  id            TEXT PK  'usr_' + 12 hex
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE   -- trimmed, lower-cased on write
  display_name  TEXT NOT NULL                          -- 1..80 chars
  password_hash TEXT                                   -- NULL until the user sets one
  instance_role TEXT NOT NULL CHECK IN ('member','owner') DEFAULT 'member'
  status        TEXT NOT NULL CHECK IN ('active','disabled') DEFAULT 'active'
  created_at, created_by, updated_at, disabled_at, password_set_at
)
board_members(
  user_id    TEXT NOT NULL REFERENCES users(id)
  department TEXT NOT NULL                             -- the board
  role       TEXT NOT NULL CHECK IN ('viewer','collaborator','owner')
  granted_by TEXT NOT NULL, granted_at TEXT NOT NULL
  PRIMARY KEY (user_id, department)
)
user_tokens(                                           -- invites and password resets
  id          TEXT PK 'utk_' + 12 hex
  token_hash  TEXT NOT NULL UNIQUE                      -- sha256 of a 32-byte random token
  purpose     TEXT NOT NULL CHECK IN ('invite','reset')
  email       TEXT NOT NULL
  user_id     TEXT                                      -- reset: the user; invite: set on accept
  department  TEXT, role TEXT                           -- invite: board grant (NULL = instance invite)
  instance_role TEXT                                    -- instance invite: 'member' or 'owner'
  created_by  TEXT NOT NULL, created_at, expires_at     -- invite 7 days, reset 24 hours
  used_at, revoked_at
)
user_sessions(
  id           TEXT PK 'uss_' + 12 hex
  user_id      TEXT NOT NULL REFERENCES users(id)
  token_hash   TEXT NOT NULL UNIQUE
  created_at, last_seen_at, expires_at                  -- 90 days absolute; 30 days idle ends it
  user_agent, ip, revoked_at
)
login_attempts(email_or_ip TEXT, at TEXT)              -- rate limiting, pruned after 1 hour (`ok:` success rows: 30 days)
```

Raw tokens are never stored; only hashes, as the pairing code does. A board-less user is
allowed (an instance invite, or every grant removed): they sign in and see no boards.

### Passwords

- Node's built-in `crypto.scrypt` (async), N = 2^15, r = 8, p = 1, **`maxmem: 64 MiB`**
  (the default limit throws at these parameters), 16-byte salt, 64-byte key, stored as
  `scrypt$<N>$<r>$<p>$<salt>$<key>`, compared with `timingSafeEqual`. 12 to 256 characters,
  no composition rules.
- A **global hashing cap**: at most 2 hashes run at once and at most 16 wait; beyond that the
  endpoint answers `429` with `Retry-After`. Each hash is ~32 MiB and ~120 ms, and per-IP limits
  alone do not bound attempts spread over many addresses. An **instance-wide failure budget** (100
  failed sign-ins per 15 minutes) bounds them too: over it, sign-in from an address that has never
  signed in is refused. See [Running behind a proxy](../behind-a-proxy.md).
- Login for an unknown or disabled email still runs one hash against a fixed dummy, so timing
  does not reveal which emails exist.
- Invite and reset tokens are looked up (by hash) and rejected before any password is hashed;
  the inspect, accept and complete endpoints share the login rate limits per IP. Behind a tunnel
  or proxy the per-IP buckets need `gateway.trustedProxies` to see real clients; without it a loopback
  peer has no IP bucket (see [Running behind a proxy](../behind-a-proxy.md)).
- Setting a password by reset, or changing one's own, revokes that user's other sessions
  (member sessions and owner device sessions alike).
- The per-email limit means anyone can temporarily lock the instance owner out of password
  sign-in. That is accepted: pairing remains the owner's fallback and the lock lasts 15 minutes.

### Sessions

**Member sessions are not device sessions.** They never enter `auth-devices.json` and use
their own cookie (`<codename>_user`, namespaced per instance like the existing cookies,
HttpOnly, SameSite=Lax, Secure when the request arrived over HTTPS). An older build does not
know the cookie, so a member's browser is simply unauthenticated there; it can never be read
as the operator. Expiry: 30 days sliding (touch throttled to 60 s) and 90 days absolute.

**Instance owners sign in to an operator device session**, a normal `auth-devices.json`
entry of kind `password` that additionally records `userId`. Disabling, demoting, resetting or
deleting that user revokes every device session carrying their `userId`, and People lists them.
Device sessions without `userId` (every paired device) are untouched by account management. An
older build reads a `password` device as an ordinary operator device, which it is.

## Principal resolution

One function, `resolvePrincipal(req)`, is used by **both** the HTTP handler and the WebSocket
upgrade handler:

1. Operator credentials (bearer token or a valid device session) → **operator**, exactly as
   today. A valid operator credential wins over a user cookie on the same request.
2. Otherwise, when gateway auth is required, a valid user-session cookie whose user is
   `active` and whose session is unexpired and unrevoked → **member** (`{ userId, sessionId }`).
   Looked up in the database on every request: no cache, so disabling a user, revoking a session
   or removing a grant applies to the next request.
3. Otherwise today's rules (session capability headers, unauthenticated).

In the HTTP handler the member branch runs after CORS and `OPTIONS`, and before the
unauthenticated 401 gate, the remote-connector status read and the `/api/` dispatch. The
**member allowlist is exactly**: `/api/member/*`, `GET /api/auth/state`,
`POST /api/auth/logout`, and the `/ws` upgrade. Every other path, `/api/*` or upgrade, answers
`403 {"error":"Not available to board members"}` for a member (`/ws/pty/*` and the plugin
events stream included; static web files are served as to anyone). A member request never
reaches the general API dispatch, so members are **default-deny by construction**: none of the
general API's routes needs auditing, and a route added later is closed to members until it is
deliberately added to the member router. Tests prove a member cookie is refused on
`/api/remote-mcp`, the plugin-events upgrade, `/ws/pty/x`, and a sample of general routes.

**Accounts require gateway auth.** Where `shouldRequireGatewayAuth` is false (loopback-only,
no auth), every same-origin browser is the operator, so a member identity would be
meaningless. There, every account endpoint other than reading state refuses with a message
saying to turn on gateway auth, the user cookie is ignored, and the UI explains why instead of
offering invites. If a config reload turns auth off while member sessions exist, member sockets
are closed (4401) and the cookie stops being honoured from the next request.

## Roles

| Capability | viewer | collaborator | owner (board) | operator |
|---|---|---|---|---|
| See the board: Todos (whole trees), comments, attachments, labels, sprint names, activity, people and employees on the board | yes | yes | yes | yes |
| Comment, reply, attach; edit or delete own comments | | yes | yes | yes |
| Create root Todos on the board | | yes | yes | yes |
| In a **member-only tree**: create sub-tasks, edit title, body, priority, labels; mark done or reopen to backlog | | yes | yes | yes |
| Invite to, change roles on, and remove people from this board | | | yes | yes |
| Anything in a tree that is not member-only, assignment, dispatch, delete, anything that starts or wakes an agent | | | | yes |
| Session transcripts, chat, org, settings, other boards | | | | yes |

A **member-only tree** is a root Todo whose every Todo (root included) has a `user:`
`created_by`, no assignee, and no linked session. It is checked over the root's whole tree at
each member write, inside the write's transaction. The moment the operator assigns or
dispatches anything in the tree it stops being member-only and members can only comment on
any of it.

**A tree the member created that left their board.** Where departments are open, an assignment can move a member-created
root to another department, or (assigned to `@operator`) to the company board. The member keeps **read** access (detail,
tree, comments, attachments, events, live frames) to the whole open tree whose root they created (`created_by =
user:<self>`), wherever it now sits, and **comment** access (comment, reply, attach, edit or delete their own comments)
when their role on the board they filed it on is collaborator or owner. That board is recorded on the root's `created`
event (`createdOnBoard`) when a member files it; a root with no recorded board gives no such access. They never edit it or
change its status, never add a sub-task to it, and reach no other Todo in the destination. The access ends, like any
out-of-grant Todo (404), when the root is done or cancelled, when the member is disabled, or when they no longer hold the
board they filed it on: removing someone from a board still revokes what they made there, moved or not, and taking a board
away never widens what they may do. Assigning within the board's department changes none of this: the Todo stays on the
board, readable and commentable, and is no longer member-editable.

Why: an agent executes its Todo's title and body, a parent cannot close over an open child, and
closing a child can wake its parent's owner. A per-Todo rule leaks: a member's sub-task under a
parent the operator later assigned could be rewritten, or closed to restart the parent's agent.
The whole-tree rule leaves no agent anywhere in a tree members can write.

**Member status changes.** The member status route allows exactly two edges in a member-only
tree: `backlog → done` (refused while the Todo has open children; members get no cascade) and
`done → backlog`, which passes `human: true` (the reopen edge requires it) and never
`cascade`, `manual` or `bounce`. `transition()` writes no child-settle row when the actor is
`user:`, so a member's close never queues a parent wake, whatever the tree.

**Members never start, wake or steer an agent in v1:**

- A member-created Todo is unassigned, and its dispatch row is written with
  `autoStart: false` in the same transaction as the create, so the board walk never starts
  it. Members cannot change it. The operator turns it into agent work by assigning it, which
  ends the tree's member-only state; the flag stays, so the operator dispatches it explicitly
  (or clears auto-start), and the walk never starts it unasked.
- Member comments are stored with `author_kind = 'system'` (below), which comment routing
  already skips: no `@mention` wakes, no reply delivery.
- Board hooks do not fire for member-originated events (create, comment, label, status) in v1.
  Suppression keys on the **resolved** actor (`creatorOf` for `todo.created`, `actorOf` for the
  rest), never on the raw `event.actor`: the created event records the source there, not the
  user. A test registers a match-all `todo.created` hook and asserts a member create fires
  nothing.

A board owner cannot grant a role above their own, cannot remove an owner other than
themselves, and cannot touch instance owners. Password resets, disabling and deleting users
are operator only.

## Attribution

Server-stamped from the principal, never from the request body. Stored so that every reader
that does not know about members **grants nothing** (fail closed), including older builds:

- **Comments**: `author_kind = 'system'`, `author = 'user:<id>'`. Comment routing returns early
  for `system`; respawn guards, board-hook actors and the board walk grant system comments no
  operator standing. Edit authority is the existing (author, author_kind) pair match.
- **Todos**: `source = 'connector'` (no reader grants it standing; plugins also write it, with
  `created_by = 'plugin:<id>'`),
  `source_ref = 'user:<id>:<nonce>'` (the `(source, source_ref)` unique index needs it unique
  per Todo), `created_by = 'user:<id>'`. `board-hooks/actor.ts` `creatorOf` reads a `user:`
  `created_by` first and returns a member actor (never `operator`).
- **Events**: `actor = 'user:<id>'` for every member write except the created event, whose
  `actor` the store sets to the source (`connector`); the member is read from `created_by`.
- **Every member check keys on the `user:` prefix** of `created_by`, `author` or `actor`, never
  on `source` or `author_kind` alone, which plugins share.
- **Every outward serialiser** derives a distinct **`member`** kind from `author` /
  `created_by` / `actor` starting with `user:` and never presents it as `system` or
  `operator`: the web wire, MCP tool output (`get_work_item`, `list_work_item_comments`), the
  board-walk render, and reply or resume prompts. Agents read a member comment as "<name>
  (board member)", not as the operator's direction. A test pins each serialiser.

`GET /api/people` (operator) and `GET /api/member/people` (members) map `user:<id>` to
`{ id, displayName, initials }`. The member version returns only people on the member's
boards plus the employees that hold or created Todos on them (`name`, `displayName`, `emoji`),
so agents render as agents without the org route. The web renders a human with a `HumanAvatar`
(initials in a distinct, square-rounded person badge), keeps the operator's current avatar,
and keeps employee emoji. Unknown or deleted users render as "Former member".

## Flows

**Invite to a board.** Operator or board owner: `POST /api/boards/:department/invites { email,
role }` (operator) or `/api/member/boards/:department/invites` (owner). If the email already
has an active account, the grant is added directly and the response says so (no link).
Otherwise a `user_tokens` invite row is created and the response carries the link once:
`<origin>/invite#<token>` (fragment, so the token is not sent in request lines or logged).
Re-inviting the same email to the same board revokes the previous unused invite.

**Invite to the instance.** Operator only: `POST /api/people/invites { email, instanceRole }`
creates an invite with no board (`department` NULL). With `instanceRole: 'owner'` the person
becomes a co-operator; the UI says so plainly before sending, and the link lasts 24 hours, not
7 days. `GET /api/people/invites` lists every pending invite (instance and board) and
`DELETE /api/people/invites/:id` revokes one; People shows pending owner invites prominently.

**Set up my sign-in.** The signed-in operator, from People, creates their own owner account:
`POST /api/account/setup { email, displayName, password }`, allowed for an operator
principal only. The current device session gains the new `userId`. From then on the login
screen works for them.

**Accept.** `/invite` reads the fragment and immediately clears it with
`history.replaceState`. `POST /api/auth/invites/inspect { token }` returns `{ email,
boardName, role, invitedBy }` or `410` when used, revoked or expired. The person enters a
display name and a password; `POST /api/auth/invites/accept { token, displayName, password }`
creates the user, the grant, a session and its cookie, and marks the token used, in one
transaction. The browser lands on the board.

**Sign in.** The existing auth gate gains an email-and-password form, shown when at least one
account exists (so first-time setup is unchanged). `POST /api/auth/login { email, password }`:
the same `401 {"error":"Email or password is incorrect"}` for unknown email, wrong password or
disabled user; 5 failures per email or 20 per IP in 15 minutes answer `429` with
`Retry-After`, checked before hashing. An instance owner gets an operator device session; a
member gets a user session.

**Reset.** The operator issues a one-time reset link from People; `/reset#<token>` (fragment
cleared on read) sets a new password and revokes the user's other sessions. A signed-in user
can change their own password (current password required) from the account menu, which also
revokes their other sessions.

**Sign out and sessions.** `POST /api/auth/logout` clears whichever session the request holds.
People shows each user's sessions (member sessions and owner device sessions); the operator can
revoke one or all.

**Revoke.** Removing a grant, disabling a user or revoking a session is a database write; the
next request resolves to no access. Live sockets are handled as below.

## Live updates

All frames go through the one gateway broadcast. A member's `/ws` socket is registered with
its user session id, and the broadcast sends it a **re-serialised** frame, never the original:

- Before each send the session is re-checked; a socket whose session is no longer valid is
  closed with code 4401.
- Only Todo-shaped change events (`company:changed` with `entity: "todo"`, Todo live events,
  comment and attachment changes) pass. Every other event type is dropped.
- A passing event is reduced to `{ entity, action, id }` (plus the member-safe Todo
  serialisation when the original carried a value). The original's `value` (a full Todo with
  session-bearing `sourceRef`), `sessionId` and anything else are never forwarded.
- An event passes when the Todo's root department **before or after** the write is one of the
  member's boards, or when the Todo is in an open tree whose root the member created (it left
  their boards and they keep reading it; sub-tasks included). When it was on a granted board
  before and is not readable after (moved or deleted), the member gets `{ entity: "todo",
  action: "removed", id }` so the card disappears; so does a root they created on the write that closes it while they
  read it as its creator (the write's own status move, which the event carries, went from open to done or cancelled; its
  sub-tasks are refetched with it), and a Todo they created on the write that reparents it out from under a tree they could
  read; a department change or assignment never ends creator access, and later writes on it send nothing, a close included. The emitter supplies the before-department where a write changes it. A move of the
  root is sent to its creator as an ordinary change (the value is marked `movedToAnotherBoard`);
  a sub-task gets no frame of its own for that move, so the web refetches the tree on the
  root's frame.

The member's web client refetches through the member API, never the general one.

## Unauthorised board by URL

Member API reads of a Todo, board or attachment outside the member's grants answer `404`, not
`403`, so a member cannot probe which ids exist. The one exception to "outside the grants" is
the creator rule under Roles: an open tree whose root the member created stays readable after it
leaves the board they filed it on, and the same `404` returns once the root is done or cancelled, the member is
disabled, or they no longer hold that board. Every other Todo in the destination still answers `404`. An attachment route checks that the
attachment belongs to that Todo, not only that the Todo is granted. The web shows "This board
isn't shared with you" with a link back to their boards. A member opening an operator-only
route (chat, org, settings) is redirected to their boards.

## Existing data and boards

No existing row is rewritten and no existing table changes shape (unknown tables are ignored
by the boot schema verifier, so rollback stays bootable). Paired devices remain operator
sessions. With no `users` rows, the sign-in form is not shown, no member path is reachable,
and every screen renders as today. On rollback to an older build the new tables stay unused,
member cookies stop working, member comments read as `system` comments and member Todos as
`connector` Todos: both grant nothing.

## Web

- **Auth gate**: email and password form plus the existing pairing path.
- **`/invite` and `/reset`** pages, outside the authenticated shell.
- **Member shell**: a minimal layout with the member's boards, the board view and the Todo
  page backed by the member API, and an account menu (name, change password, sessions, sign
  out). Composer and new-Todo controls only for collaborators and owners; edit controls only
  in member-only trees.
- **Operator**: Settings → People (users, their boards and roles, status, reset link, sessions,
  disable, instance invite, "Set up my sign-in") and a **Share** button on a department board
  (members of that board, invite with role, change role, remove). A pending invite's link is
  shown once; to resend, re-invite, which revokes the old link.
- **Attribution**: `HumanAvatar` and names on comments, activity, Todo cards (created by, last
  touched) and the Todo page, for both the operator's and a member's view.

## Person and agent assignees

A Todo has two assignee slots that answer different questions. The **agent** is who does the work; the **person** is who is
responsible for it. They are set and cleared independently. Once an instance has an account, the board card, the list row and
the Todo page show both (a person circle, then an agent circle; the Todo page has a "Person" and an "Agent" row).

- **Agent slot = the existing `assignee`**, unchanged in storage, dispatch and semantics. It shows only when `assignee` is an
  employee; `@operator` there is the "needs the operator" marker and reads as an empty agent slot.
- **Person slot = `todo_people`**, a new additive table registered with the boot shape verifier beside the account tables:
  `todo_id TEXT PRIMARY KEY, person TEXT NOT NULL, set_by TEXT NOT NULL, set_at TEXT NOT NULL`. `person` is `@operator` or
  `user:<id>`; one per Todo. No existing table changes shape and no existing row is rewritten, so an older build ignores it
  and a rollback stays bootable. Deleting a user deletes their rows in the same transaction. Nothing deletes a Todo today;
  whatever does must call `clearTodoPerson`, because the table is keyed by Todo id alone (no foreign key, so a rebuild of
  `work_items` never has to know about it). Removing a board grant keeps the row, and the person still renders by name.
- **`humanAssignee: string | null`** is on every Todo serialisation (list rows, board rows, detail, tree nodes, live frames):
  the row, else `@operator` when `assignee` is. List pages and the detail payload add a `members` map from `user:<id>` to
  `{ kind: "member", displayName }` when a row names a user. Members see the member serialiser's actor mapping: a `user:` id
  on one of their boards stays, any other user is the generic `member`, and `@operator` stays. MCP `get_work_item` and the
  list tools show the person as "<name> (board member)" or "operator", never a user as the operator (the sentinel-reuse
  rule above), and "Former member" for a user who is gone.
- **Who can be chosen**: `@operator`, or an active user with a grant of any role on the Todo's root board, or an instance
  owner. Anyone else is `422`. The operator can always choose themselves, with zero accounts.
- **A member-created Todo starts with its creator as the person**, written in the create's transaction.

### The operator as the person keeps today's meaning, by storage

The operator in the person slot is stored the way "needs the operator" always was, so every reader of `assignee` (the
attention lane, backlog dispatch, quiet-watch, the review addressee) keeps meaning what it meant. One writer owns the rules
(`work-items/person-write.ts`), whichever route reaches them (the operator's edit, the assign route, the internal write):

| Edit | Stored |
|---|---|
| Person `@operator`, no agent | `assignee = '@operator'`, no `todo_people` row (an `@operator` assignee never has a row) |
| Person `@operator`, agent X | `assignee = X`, row `@operator` (the agent owns execution) |
| Set an agent X while `assignee = '@operator'` | `assignee = X`, row `@operator` (the operator stays the person) |
| Clear the agent while the row is `@operator` | `assignee = '@operator'`, row deleted (it needs the operator again) |
| Clear the person while `assignee = '@operator'` | `assignee = null` |
| Name another person while `assignee = '@operator'` | `assignee = null`, row = that person (it no longer waits on the operator) |
| Assign to the operator over a person's row | `assignee = '@operator'`, row deleted, `person_changed` records it |

Choosing yourself with no agent is therefore an assignment to the operator, written by the pen's `assignee` write (the
department is left alone, unlike the assign route, which derives it) and it fires what an assignment to the operator has
always fired. A test drives it end to end through the edit route against a twin Todo given to the operator through the assign
route, and asserts the same `assignee`, attention lane, review addressee, board-walk refusal, operator desk membership and
quiet-watch treatment, then sets an agent, clears it, and asserts the "needs you" state returns.

### Who can set it

- **Operator**: any Todo, through the Todo edit route (`humanAssignee`, version-fenced like the other fields; an agent session
  that sends it is refused as for `assignee`).
- **Collaborators and board owners**: any Todo on their board (agent-created ones included) through
  `PUT /api/member/todos/:id/person { person: string | null }`: a label of responsibility, not steering, so it needs no
  member-only tree. **Members never write `assignee` and never choose `@operator`.** The route accepts only a `user:<id>` with
  access to the board, or `null`: `@operator` is `422`. On a Todo whose person is the operator (a row, or the `assignee`
  fallback) it answers `403` (`person_operator_only`) and changes nothing. A member's change only ever touches
  `todo_people`. Viewers get `403`; a Todo outside the member's grants is `404`. The route is in the member router, so the
  allowlist and default-deny are unchanged.
- **Nothing wakes.** A person change writes one `person_changed` event `{ from, to }` (plus `assigneeCleared` when it cleared
  the operator out of `assignee`), emitted as an ordinary Todo update so cards refresh live. It never starts, wakes or
  notifies an agent, fires no board hook, and is never written as `metadata_edited`, which a hook reads. The one exception is
  the operator choosing themselves with no agent, which is an assignment to the operator and fires what that fires. It is on
  the member event-detail allowlist with its ids mapped like any actor. There is no agent tool to set it.

### Web

- **With no account on the instance the UI is today's, unchanged**: a single assignee circle on the card and the list row, a
  single "Assignee" row and chip on the Todo page whose picker keeps its operator option and its assign lane. The two-slot
  surfaces appear once `hasAccounts` (already on `GET /api/auth/state`) is true, so the first account turns them on.
- With accounts: two 20px circles on the card and the list row (`HumanAvatar`, or the operator's own avatar, then
  `EmployeeAvatar`), a dashed outline with "No person" / "No agent" for an empty slot. The card no longer shows its creator in
  a free slot. The Todo page has a Person row and chip (the operator's picker offers "You (operator)" and the board's people,
  with a clear button) and an Agent row and chip whose picker lists employees only. A member gets the person picker where they
  are a collaborator or owner, without the operator option, and read-only on a Todo whose person is the operator; the agent
  row is read-only for members.

## Phases

1. **Identity core** (gateway): tables, password hashing, user sessions and cookie, principal
   resolution and the default-deny routing, login, logout, invite, accept, reset, rate
   limiting and the hashing cap, owner device sessions linked to users, instance invite and
   "set up my sign-in", operator People and board-share APIs.
2. **Member board API and live filtering** (gateway): `/api/member/*` board, Todo, comment,
   attachment and people routes per the role table, attribution writers and the `member` kind
   in every outward serialiser, hook suppression, `autoStart: false`, filtered sockets.
3. **Web**: auth gate sign-in, invite and reset pages, member shell, People, Share,
   `HumanAvatar` attribution. Built against the API contract below with mocked responses,
   then wired to the real gateway.
4. **Evidence**: two signed-in browsers against an ephemeral instance, before and after
   screenshots, direct-URL probe of an unshared board, revoke while signed in.

## API contract (v1)

Unauthenticated: `GET /api/auth/state` (adds `accountsEnabled`, `principal: { kind:
"operator" } | { kind: "member", user, boards: [{ department, role }] } | null`),
`POST /api/auth/login`, `POST /api/auth/invites/inspect`, `POST /api/auth/invites/accept`,
`POST /api/auth/resets/inspect`, `POST /api/auth/resets/complete`, `POST /api/auth/logout`.

Operator: `GET /api/people`, `GET/PATCH/DELETE /api/people/:id` (display name, status,
instance role), `POST /api/people/:id/reset-link`, `GET /api/people/:id/sessions`,
`DELETE /api/people/:id/sessions[/:sid]`, `GET/POST /api/people/invites`,
`DELETE /api/people/invites/:id`,
`POST /api/account/setup`, `GET /api/boards/:department/members`,
`POST /api/boards/:department/invites`, `DELETE /api/boards/:department/invites/:id`,
`PATCH/DELETE /api/boards/:department/members/:userId`, `POST /api/account/password` (owner
users changing their own password), and the operator's Todo edit `PATCH /api/work-items/:id`, which takes `humanAssignee`
(see "Person and agent assignees").

Member: `GET /api/member/me`, `POST /api/member/password`, `GET /api/member/sessions`,
`DELETE /api/member/sessions/:id`, `GET /api/member/boards`, `GET /api/member/people`,
`GET /api/member/boards/:department/todos` (same query shape and item serialisation as the
board's existing list), `GET /api/member/boards/:department/moved` (the open root Todos the member filed on that board that are now on none of their
boards), `GET /api/member/todos/:id`, `GET /api/member/todos/:id/tree`,
`GET /api/member/todos/:id/comments`, `GET /api/member/todos/:id/attachments[/:aid]`,
`POST /api/member/boards/:department/todos` (root, or `parentId` in a member-only tree), `PATCH /api/member/todos/:id` (title, body,
priority, labels; member-only trees only), `POST /api/member/todos/:id/status`
(`done` or `backlog`, member-only trees, edges as in Roles), `PUT /api/member/todos/:id/person` (`{ person: string | null }`: a `user:<id>` or null, collaborators and owners, any Todo on the board),
`POST /api/member/todos/:id/comments`, `PATCH/DELETE
/api/member/todos/:id/comments/:cid`, `POST /api/member/todos/:id/attachments`, and the owner
board-share routes under `/api/member/boards/:department/…` mirroring the operator's.

Serialisations reuse the existing Todo, comment and attachment shapes, minus fields that
reference sessions (session ids, run ids, transcripts), which are omitted for members.

### Response shapes

Settled while building the web against this contract; the gateway answers exactly these.

- `GET /api/auth/state` adds `accountsEnabled` (gateway auth is on, so accounts are possible),
  `hasAccounts` (at least one user exists; the sign-in form shows when both are true) and
  `principal`. A member principal is `{ kind: "member", user: { id, email, displayName },
  boards: [{ department, role }] }`.
- `GET /api/member/boards` → `{ boards: [{ department, role, prefix, displayName? }] }`
  (`prefix` is the board's Todo-id prefix).
- Member writes answer with the operator routes' shapes and take the same bodies:
  `PATCH /api/member/todos/:id` takes `expectedVersion` / `idempotencyKey` and returns
  `{ workItem, replayed }`; `POST /api/member/todos/:id/status` takes `{ status }` and returns
  `{ workItem, escalated: false }`; `POST /api/member/todos/:id/comments` takes
  `{ body, parentCommentId? }` and returns `{ comment }`. `GET /api/member/todos/:id` returns
  the operator detail shape (comments and events included) minus session fields.
- `GET /api/people` → `{ people: [{ id, email, displayName, initials, instanceRole, status,
  boards: [{ department, role }], passwordSet, createdAt, lastSeenAt }] }`.
- `GET /api/people/:id/sessions` and `GET /api/member/sessions` → `{ sessions: [{ id,
  kind: "member" | "device", createdAt, lastSeenAt, userAgent, ip, current }] }`, where
  `current` is true for the session the request itself rides on.
- `GET /api/people/invites` → `{ invites: [{ id, email, department | null, role | null,
  instanceRole | null, createdBy, createdAt, expiresAt }] }`.
- `GET /api/boards/:department/members` and its member mirror → `{ members: [{ userId,
  displayName, email, initials, role }], invites: [<invite row as above>] }`.
- `GET /api/member/boards/:department/moved` → the board list wrapper `{ workItems, total, nextOffset: null, totals, limit, offset }`
  with compact rows, each carrying `movedToAnotherBoard: true` and `memberCanComment`; `404` for a board the member does not hold.
- `GET /api/member/people` → `{ people: [{ id, displayName, initials }], employees: [{ name,
  displayName, emoji }] }`.
- Invite and reset-link POSTs → `{ link, expiresAt }` (`link` is `null` when the gateway cannot
  determine the request's origin; the UI then says so instead of offering a copy box); an invite
  to an existing active account → `{ granted: true }`.
- `POST /api/auth/invites/inspect` → `{ email, boardName, role, instanceRole, invitedBy }`
  (`boardName` and `role` are null for an instance invite, `instanceRole` null for a board
  invite); `POST /api/auth/resets/inspect` → `{ email, displayName }`. Both answer `410` for a
  used, revoked or expired token.
- Member Todo reads keep the operator wrappers the shared board code reads: board list
  `{ workItems, total, nextOffset, totals }`, tree `{ tree: { root, totals, spendUsd } }`,
  detail `{ workItem, spendUsd, events, comments }`. `totals` is a status-to-count record and
  its counts are numbers for everyone. For members every cost figure is `null` (`spendUsd` at
  each level, `workItem.budgetUsd`) and every session or run field is removed.
  Members never see spend.
- Actors on member reads and member socket frames are only ever an employee name, a
  `user:<id>` of someone currently on one of the member's boards, `operator`, or a generic
  `agent` / `system` / `member` with no identifier (`member` stands for any other person; the
  web renders it "Former member"). A Todo's `created` event actor is its creator from
  `created_by` (through the same mapping), never the event's raw source token. `session:<uuid>`, `plugin:<id>`, cron and other internal ids are never sent to a
  member. Error messages to members never enumerate company data (labels, boards, people).

- `PUT /api/member/todos/:id/person` → `{ workItem }` (the member serialisation, carrying `humanAssignee`). `403` for a viewer,
  and for any change to a Todo whose person is the operator (`person_operator_only`); `404` outside the member's grants;
  `422` (`todo_invalid_person`) for `@operator` or someone who may not be chosen; `400` for a malformed body.
- `humanAssignee: string | null` is on every Todo serialisation (list rows, board rows, detail, tree nodes, live frames). List
  pages and the detail payload add a `members` map from `user:<id>` to `{ kind: "member", displayName }` when a row names a user.

### Phase 2 build notes

Where the build had to pick a reading, or the contract was silent, it did this:

- **Member PATCH needs a version, except for labels.** A change to title, body or priority carries `expectedVersion`
  (or `If-Match`) as the operator's edit does. A labels-only call replaces a set, like the operator's labels route,
  and needs none. Labels fold into the idempotency key, because the store's fingerprint does not cover them.
- **Fields only the operator sets** (`assignee`, `department`, `rank`, `dueAt`, `startAt`, `status` on PATCH,
  `autoStart`, `sprint`, source fields) answer 403 on create and PATCH; any other unknown field answers 400.
- **Idempotency keys are scoped to the member** (`user:<id>:<key>`), so two people's identical keys never replay one another.
- **Attachments upload as multipart only.** The operator's JSON form names a path on the gateway's disk; a member never gets it.
  Member attachment rows omit `storagePath`. There is no member route to delete an attachment.
- **Status moves by a member reach no automation.** Besides the child-settle row, a member's move is not handed to the
  workflow status trigger, which can start agents.
- **Member reads neutralise** `sourceRef` (null), `budgetUsd` (null), the operator's Home flag (`kept: false`), attention lane (`attentionLane: null`) and review addressee (`reviewAddressee: { kind: "operator" }`); they remove
  `runs`, `dispatchConfig` and a list row's `sessionRef` (removed); every spend figure is `null`; events leave out the operator's machinery (session links, recovery, quiet-watch,
  claims) and name only an employee, `operator`, the `user:<id>` of someone on one of the member's boards (an active account), or a generic `agent` / `system` / `member` (a session, plugin, cron job or the gateway's own machinery never shows an identifier); relations are shown only to a Todo on a board the member also holds.
  A member's event is built field by field (`id`, `workItemId`, `kind`, `fromStatus`, `toStatus`, the mapped `actor`, `detail`, `createdAt`), and its `detail` keeps only the keys its kind allows, the ones the member web renders (for example `childId`, `commentId`, `labels`, `filename`, a move's `note` and `reason`, a note's `assignee`); any other key is dropped whatever it holds. What is kept is judged by value too: a Todo id the member cannot read, another board's name, a session or internal identity are dropped, and a person reads as the actor rule says. A Todo's own `department`, and a label's, read `null` when they name another department.
  Comments carry no `sessionId`.
- **`GET /api/member/people` employees** are the employees that hold, created or commented on a Todo on one of the member's boards, or in a tree they created that has left the board they filed it on.
- **Member frames** are `{ event: "company:changed", payload: { entity: "todo", action, id, version?, value? }, ts }`;
  `removed` carries only `{ entity, action, id }`. A write that moves a board sends `fromDepartment` on the operator's event
  (a department change, an assignment that derives one, a reparent), and the member feed reads it.
- **Assignment can move a card off a shared board.** Where departments are open, assigning a Todo derives its department
  from the assignee's, so a member's card leaves their board when the operator assigns a Todo to an employee elsewhere (other members
  of the board see `removed`). A root the member created stays readable to them (next bullet). Dedicated departments keep it.
- **Creator access to a tree that left the board.** One function (`todoAccess`) answers how a member reads a Todo: through a
  board they hold, else as the creator of its open root while they still hold the board it was filed on, else not at all. Reads,
  comment and attachment writes, the replay of an idempotent create and live frames all use it. A Todo read only as its creator
  carries `movedToAnotherBoard: true` and `memberCanComment` (their role on the board they filed it on) on the detail, tree
  nodes, list rows and frame values; its root's `department` reads `null` and nothing names where it went, unless the member
  holds a grant there, in which case it is an ordinary Todo on that board. Edits, status changes and sub-tasks under it
  answer `403 todo_not_member_editable` where the route reaches it (a sub-task route for another board answers `404`).
  `GET /api/member/boards/:department/moved` lists the roots filed on that board (compact rows, newest first, at most 200, `404`
  for a board they do not hold). The employee list covers their trees too. Frames: a Todo they made sends `removed` (id only) only on the write that took it out of their reach: the status write that closed a root they read as its creator (the event carries that write's own `fromStatus` and `toStatus`, and the member feed reads those, never the Todo's latest event; a cascade's sub-tasks send nothing of their own), or a reparent out from under a tree they could read (the reparent event carries `fromRootId`). A department change or an assignment never ends creator access, and every later write on a lost Todo is silent, a close of one they had already lost included.
- **The outward `member` kind** is derived for comments (web wire, MCP tools, board walk, Talk, reply prompts). A Todo,
  event or attachment names its member by the raw `user:<id>` on `createdBy`, `actor` or `uploadedBy`, which no reader
  mistakes for the operator; `get_work_item` adds a `members` map from those identities to names.
- **Phase 1 corrections made here to match "Response shapes":** `accountsEnabled` / `hasAccounts` on `GET /api/auth/state`;
  `initials`, `passwordSet`, `lastSeenAt` on People rows; the board members list shape; `expiresAt` on invite responses.
  `POST /api/member/password` and `GET`/`DELETE /api/member/sessions` (own sessions only) are mounted.

### What members can and cannot infer

- **Free text is not redacted.** Titles, bodies, notes and comments on a Todo a member can
  see reach them as written, including any Todo ids or board names in them. Anything the
  operator or an agent writes on a shared Todo is visible to that board's members. This is the
  same expectation as writing in any shared document; redacting prose would mangle it and
  could never be complete.
- **Todo id prefixes are not secrets.** A member sees ids of Todos they may read. A sub-task
  that sits in another open department can carry that department's prefix. A prefix is a
  short code, not the board's name, and it gives no access: every other Todo still answers 404.
- **A moved tree says only that it moved.** The creator of a tree that left the board they filed it on reads "moved to another board", never
  the destination's name, unless they hold a grant there. A sub-task made on the board they held keeps naming that board.
- **Structured data hides other boards.** Board names (departments) and references to Todos
  the member cannot read are removed from every structured field of member reads and frames:
  event details, relations, moved-from and moved-to. A moved Todo reads "moved to another
  board".
