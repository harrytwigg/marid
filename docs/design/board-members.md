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
- Assigning a Todo to a human. v1 shows a person as the creator and last toucher of a Todo;
  human assignees touch the board walk and follow later.
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
login_attempts(email_or_ip TEXT, at TEXT)              -- rate limiting, pruned after 1 hour
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
  alone do not bound attempts spread over many addresses.
- Login for an unknown or disabled email still runs one hash against a fixed dummy, so timing
  does not reveal which emails exist.
- Invite and reset tokens are looked up (by hash) and rejected before any password is hashed;
  the inspect, accept and complete endpoints share the login rate limits per IP.
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
  member's boards. When it was on a granted board before and is not after (moved or deleted),
  the member gets `{ entity: "todo", action: "removed", id }` so the card disappears. The
  emitter supplies the before-department where a write changes it.

The member's web client refetches through the member API, never the general one.

## Unauthorised board by URL

Member API reads of a Todo, board or attachment outside the member's grants answer `404`, not
`403`, so a member cannot probe which ids exist. An attachment route checks that the
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
users changing their own password).

Member: `GET /api/member/me`, `POST /api/member/password`, `GET /api/member/sessions`,
`DELETE /api/member/sessions/:id`, `GET /api/member/boards`, `GET /api/member/people`,
`GET /api/member/boards/:department/todos` (same query shape and item serialisation as the
board's existing list), `GET /api/member/todos/:id`, `GET /api/member/todos/:id/tree`,
`GET /api/member/todos/:id/comments`, `GET /api/member/todos/:id/attachments[/:aid]`,
`POST /api/member/boards/:department/todos` (root, or `parentId` in a member-only tree), `PATCH /api/member/todos/:id` (title, body,
priority, labels; member-only trees only), `POST /api/member/todos/:id/status`
(`done` or `backlog`, member-only trees, edges as in Roles), `POST /api/member/todos/:id/comments`, `PATCH/DELETE
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
- `GET /api/people/:id/sessions` → `{ sessions: [{ id, kind: "member" | "device", createdAt,
  lastSeenAt, userAgent, ip }] }`.
- `GET /api/people/invites` → `{ invites: [{ id, email, department | null, role | null,
  instanceRole | null, createdBy, createdAt, expiresAt }] }`.
- `GET /api/boards/:department/members` and its member mirror → `{ members: [{ userId,
  displayName, email, initials, role }], invites: [<invite row as above>] }`.
- `GET /api/member/people` → `{ people: [{ id, displayName, initials }], employees: [{ name,
  displayName, emoji }] }`.
- Invite and reset-link POSTs → `{ link, expiresAt }`; an invite to an existing active
  account → `{ granted: true }`.
