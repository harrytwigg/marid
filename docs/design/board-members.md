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
  department  TEXT, role TEXT                           -- invite only
  created_by  TEXT NOT NULL, created_at, expires_at     -- invite 7 days, reset 24 hours
  used_at, revoked_at
)
user_sessions(
  id           TEXT PK 'uss_' + 12 hex
  user_id      TEXT NOT NULL REFERENCES users(id)
  token_hash   TEXT NOT NULL UNIQUE
  created_at, last_seen_at, expires_at                  -- 30 days sliding, touch throttled to 60 s
  user_agent, ip, revoked_at
)
login_attempts(email_or_ip TEXT, at TEXT)              -- rate limiting, pruned after 1 hour
```

Raw tokens are never stored; only salted or prefixed hashes, as the pairing code does.
Passwords use Node's built-in `crypto.scrypt` (N = 2^15, r = 8, p = 1, 16-byte salt, 64-byte
key), stored as `scrypt$<N>$<r>$<p>$<salt>$<key>`, compared with `timingSafeEqual`. Minimum
12 characters, maximum 256; no other composition rules.

**Member sessions are not device sessions.** They never enter `auth-devices.json` and use
their own cookie (`<codename>_user`, namespaced per instance like the existing cookies,
HttpOnly, SameSite=Lax, Secure when the request arrived over HTTPS). An older build does not
know the cookie, so a member's browser is simply unauthenticated there; it can never be read
as the operator.

## Principal resolution

The request handler resolves exactly one principal, in this order:

1. Operator credentials (bearer token or a valid device session) → **operator**, exactly as
   today. A valid operator credential wins over a user cookie on the same request.
2. Otherwise a valid user-session cookie whose user is `active` and session is unexpired and
   unrevoked → **member** (`{ userId }`). Looked up in the database on every request: no
   cache, so disabling a user, revoking a session or removing a grant applies to the next
   request.
3. Otherwise today's rules (session capability headers, unauthenticated).

A member request is answered **only** by the member router (`/api/member/*`) and the shared
auth routes (`/api/auth/state`, `/api/auth/logout`). It never reaches the general API
dispatch: any other `/api/*` path answers `403 {"error":"Not available to board members"}`.
This is the security property of the design: members are **default-deny by construction**,
so none of the general API's routes needs auditing for member access, and a route added
later is closed to members until someone deliberately adds it to the member router.

**Accounts require gateway auth.** On an instance where `shouldRequireGatewayAuth` is false
(loopback-only, no auth), any same-origin browser is the operator, so a member identity would
be meaningless. There, every account endpoint other than reading state refuses with a message
saying to turn on gateway auth, the user cookie is ignored, and the UI explains why instead of
offering invites.

## Roles

| Capability | viewer | collaborator | owner (board) | operator |
|---|---|---|---|---|
| See the board: Todos (whole trees), comments, attachments, labels, sprint names, activity, people on the board | yes | yes | yes | yes |
| Create Todos and sub-tasks on the board (unassigned, never auto-started) | | yes | yes | yes |
| Comment, reply, attach; edit or delete own comments | | yes | yes | yes |
| Edit title, body, priority, labels of the board's Todos | | yes | yes | yes |
| Invite to, change roles on, and remove people from this board | | | yes | yes |
| Status changes, assignment, dispatch, delete, anything that starts or wakes an agent | | | | yes |
| Session transcripts, chat, org, settings, other boards | | | | yes |

Member comments never route: `@mentions` in them are stored as text and wake nobody. Agents
see member comments as ordinary thread content when they next read the Todo.

A board owner cannot grant a role above their own, cannot remove the last owner they are not,
and cannot touch instance owners. Password resets, disabling and deleting users are operator
only.

## Attribution

Server-stamped from the principal, never from the request body:

- Todo `created_by` = `user:<id>`, `source` = `human`, `source_ref` = `user:<id>`.
- Event `actor` = `user:<id>`.
- Comment `author_kind` = `operator` (the human side; the column's CHECK has no other human
  value and widening it would rebuild the table) and `author` = `user:<id>`. **The operator is
  the pair (`operator`, `operator`)**, which `comments.ts` already uses for edit authority.
  The readers that test only `authorKind === "operator"` (board-hook actor, respawn guard,
  comment routing, web activity labels) change to the pair, so a member's comment is never
  read as the operator's feedback and never re-starts an agent.

`GET /api/people` (operator) and `GET /api/member/people` (members: people on their boards
only) map `user:<id>` to `{ id, displayName, initials }`. The web renders a human with a
`HumanAvatar` (initials in a distinct, square-rounded person badge), keeps the operator's
current avatar, and keeps employee emoji. Unknown or deleted users render as "Former member".

## Flows

**Invite.** Operator or board owner: `POST /api/boards/:department/invites { email, role }`
(operator) or `/api/member/boards/:department/invites` (owner). If the email already has an
active account, the grant is added directly and the response says so (no link). Otherwise a
`user_tokens` invite row is created and the response carries the link once:
`<origin>/invite#<token>` (fragment, so the token is not sent in request lines or logged).
Re-inviting the same email to the same board revokes the previous unused invite.

**Accept.** `/invite` reads the fragment, `POST /api/auth/invites/inspect { token }` returns
`{ email, boardName, role, invitedBy }` or `410` when used, revoked or expired. The person
enters a display name and a password; `POST /api/auth/invites/accept { token, displayName,
password }` creates the user, the grant, a user session and its cookie, marks the token used,
in one transaction. The browser lands on the board.

**Sign in.** The existing auth gate gains an email-and-password form, shown when at least one
account exists (so first-time setup is unchanged). `POST /api/auth/login { email, password }`:
the same `401 {"error":"Email or password is incorrect"}` for unknown email, wrong password or
disabled user; 5 failures per email or 20 per IP in 15 minutes answer `429` with
`Retry-After`, checked before hashing. An instance owner gets an operator device session; a
member gets a user session.

**Reset.** The operator issues a one-time reset link from People; `/reset#<token>` sets a new
password and revokes the user's other sessions. A signed-in user can change their own
password (current password required) from the account menu.

**Sign out and sessions.** `POST /api/auth/logout` clears whichever session the request holds.
People shows each user's sessions; the operator can revoke one or all.

**Revoke.** Removing a grant, disabling a user or revoking a session is a database write; the
next request resolves to no access. Live sockets are dropped as below.

## Live updates

A member's `/ws` socket is registered with its user session id. Before each broadcast, the
gateway re-checks that the session is still valid and filters events: only Todo-shaped
change events (`entity: "todo"`, comment, attachment) whose Todo's root department is one of
the member's boards, re-read at send time; every other event type is dropped. A socket whose
session is no longer valid is closed with code 4401. The member's web client refetches through
the member API, never the general one.

## Unauthorised board by URL

Member API reads of a Todo, board or attachment outside the member's grants answer `404`, not
`403`, so a member cannot probe which ids exist. The web shows "This board isn't shared with
you" with a link back to their boards. A member opening an operator-only route (chat, org,
settings) is redirected to their boards.

## Existing data and boards

No existing row is rewritten and no existing table changes shape. Paired devices remain
operator sessions. With no `users` rows, the sign-in form is not shown, no member router path
is reachable, and every screen renders as today. Rollback to an older build leaves the new
tables in place and unused; member cookies stop working there; member comments render as
operator-kind comments with a `user:<id>` author (cosmetic only).

## Web

- **Auth gate**: email and password form plus the existing pairing path.
- **`/invite` and `/reset`** pages, outside the authenticated shell.
- **Member shell**: a minimal layout with the member's boards, the board view and the Todo
  page backed by the member API, and an account menu (name, change password, sessions, sign
  out). Composer and new-Todo controls only for collaborators and owners.
- **Operator**: Settings → People (users, their boards and roles, status, reset link, revoke
  sessions, disable) and a **Share** button on a department board (members of that board,
  invite with role, change role, remove). A pending invite's link is shown once; to resend,
  re-invite, which revokes the old link.
- **Attribution**: `HumanAvatar` and names on comments, activity, Todo cards (created by, last
  touched) and the Todo page, for both the operator's and a member's view.

## Phases

1. **Identity core** (gateway): tables, password hashing, user sessions and cookie, principal
   resolution and the default-deny routing, login, logout, invite, accept, reset, rate
   limiting, operator People and board-share APIs, the comment-reader pair fix.
2. **Member board API and live filtering** (gateway): `/api/member/*` board, Todo, comment,
   attachment and people routes per the role table, attribution writers, filtered sockets.
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
`DELETE /api/people/:id/sessions[/:sid]`, `GET /api/boards/:department/members`,
`POST /api/boards/:department/invites`, `DELETE /api/boards/:department/invites/:id`,
`PATCH/DELETE /api/boards/:department/members/:userId`, `POST /api/account/password` (owner
users changing their own password).

Member: `GET /api/member/me`, `POST /api/member/password`, `GET /api/member/sessions`,
`DELETE /api/member/sessions/:id`, `GET /api/member/boards`, `GET /api/member/people`,
`GET /api/member/boards/:department/todos` (same query shape and item serialisation as the
board's existing list), `GET /api/member/todos/:id`, `GET /api/member/todos/:id/tree`,
`GET /api/member/todos/:id/comments`, `GET /api/member/todos/:id/attachments[/:aid]`,
`POST /api/member/boards/:department/todos`, `PATCH /api/member/todos/:id` (title, body,
priority, labels only), `POST /api/member/todos/:id/comments`, `PATCH/DELETE
/api/member/todos/:id/comments/:cid`, `POST /api/member/todos/:id/attachments`, and the owner
board-share routes under `/api/member/boards/:department/…` mirroring the operator's.

Serialisations reuse the existing Todo, comment and attachment shapes, minus fields that
reference sessions (session ids, run ids, transcripts), which are omitted for members.
