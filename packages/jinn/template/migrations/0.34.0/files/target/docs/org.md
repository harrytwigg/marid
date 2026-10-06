# Organization

{{portalName}} supports an organizational structure with employee personas, departments, ranks, Todos, and inter-agent sessions.

## Employee Personas

Employee files live at `~/.jinn/org/<department>/<name>.yaml`.

```yaml
name: alice
displayName: Alice
department: engineering
rank: senior
engine: claude
model: opus
persona: |
  You are Alice, a senior engineer focused on backend systems.
  You write clean, well-tested code and prefer simple solutions.
  You review PRs thoroughly and flag potential performance issues.
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Unique identifier (lowercase, no spaces) |
| `displayName` | string | no | Human-readable name (default: `name`) |
| `department` | string | no | Department directory name (default: the directory the file sits in) |
| `rank` | string | no | One of: executive, manager, senior, employee (default: `employee`) |
| `engine` | string | no | One of: claude, codex, antigravity, grok, pi, hermes, opencode (default: `claude`) |
| `model` | string | no | Engine-compatible model override (default: `sonnet`) |
| `persona` | string | yes | System prompt defining personality and behavior (required for a new employee; a file that only tunes a built-in system employee may omit it) |
| `reportsTo` | string or list | no | Who this employee reports to; unset means the root |
| `effortLevel` | string | no | Default effort level for sessions assigned to this employee |
| `alwaysNotify` | boolean | no | Notify the parent session when this employee's child session completes (default `true`) |
| `emoji` | string | no | Icon shown in the sidebar and org chart |
| `cliFlags` | string list | no | Extra CLI flags passed to the engine |
| `mcp` | boolean or string list | no | MCP servers this employee uses: `true` all, `false` none, or a list of server ids |
| `jinnMcp` | boolean | no | Force the built-in `jinn` company toolset on or off for this employee (see `mcp.md`) |
| `provides` | list | no | Services (`name`, `description`) this employee offers to others |
| `remoteHost` | string | no | Run this employee's sessions over SSH on this host (engines `claude`, `pi`, `opencode` only) |
| `remoteUser` | string | no | SSH user on `remoteHost` (default: ssh's own resolution) |
| `remoteCwd` | string | no | Absolute working directory on the remote host, required when `remoteHost` is set; must sit under `remote.root` in `config.yaml` |
| `remoteClaudeConfigDir` | string | no | Absolute path used as `CLAUDE_CONFIG_DIR` for this employee's sessions on the remote host |
| `claudeConfigDir` | string | no | Absolute path of the Claude Code profile this employee's **local** sessions run on (see "Claude profiles" below). Not allowed with `remoteHost` |

The `remote*` fields need a `remote` block in `config.yaml`. A bad remote target is refused at load: that one employee is skipped and the rest of the org still loads.

### Claude profiles

By default every local Claude session runs on the gateway's own Claude Code login. `claudeConfigDir` puts one employee on another login, for example a friend's account that the friend lets you use for their side project.

1. Sign the profile in once, on the gateway's machine: run `CLAUDE_CONFIG_DIR=/Users/<you>/.claude-friend claude`, then `/login`. On macOS the login is kept in its own Keychain item, so it does not replace yours.
2. Set the same path on the employee: `claudeConfigDir: /Users/<you>/.claude-friend`. Write it exactly as you signed it in. Claude Code names the login after the exact string, so `/Users/<you>/.claude-friend/` with a trailing slash is a different login. The gateway removes a trailing slash and any `.` or `..` segments when it loads the file, so sign in with that form.

The path must be absolute, must not start with `~`, must not lie inside the instance home, and must not be the gateway's own profile. A bad value skips that one employee at load, as a bad remote target does. The field is YAML-only. The org chart shows a profile badge on the employee, and the employee panel shows the path read-only.

Before each turn the gateway checks that the profile exists and is signed in, by the Keychain item's name on macOS or by `<profile>/.credentials.json` elsewhere. It never reads the secret. If the check fails, the turn is refused with the command that signs the profile in.

**What goes to that account.** Every prompt, tool output and file read in the employee's sessions goes to the profile's account. That includes the company context every unscoped session loads: this instance's `CLAUDE.md`, every skill and `knowledge/state.md`. A profile is independent of the employee's department, and setting one does not limit what the employee can reach. The profile's own user-level skills, plugins, settings and claude.ai connectors also load. The gateway carries three of your own settings into those sessions, because the profile cannot read them: `attribution`, your `PreToolUse` hooks and `skipDangerousModePermissionPrompt`.

**Limits.** Each profile is its own account. Its usage limit and its login failures hold back only its own sessions, and yours hold back only yours. The Limits page shows it as its own card, and the board walk judges it on its own (see "Claude accounts"). A profile's session has no fallback unless the profile is declared under `engines.claude.accounts` with a chain of its own: otherwise, when it hits its limit, it waits for its own reset, whatever `engines.claude.fallback` says.

Two employees may share one profile, and then they share its limits. `remoteClaudeConfigDir` is the remote equivalent, and the remote employee keeps the engine fallback chain.

### Claude accounts

An account is an engine plus the login it runs as. Claude has one per login:

| Account | Key | Who runs on it |
| --- | --- | --- |
| The gateway's own profile | `claude` | Every local employee without `claudeConfigDir` |
| A local named profile | `claude:<key>`, `<key>` the first 8 hex of sha256 of the path | Employees with that `claudeConfigDir` |
| A remote host's login | `claude@<user>@<host>`, or `claude@<host>` with no `remoteUser`; plus `:<key>` for a named remote profile | Remote employees on that host, user and profile |

Usage limits, engine health, the usage history and the rate-limit backoff are kept per account, so one account at its limit holds back only its own sessions. Departments play no part: two departments on one account share its limits.

**The Limits page** shows one card per account, grouped by engine, the default first; each extra card names its employees. A local profile is read with its own login, never `$CLAUDE_CODE_OAUTH_TOKEN`. A remote login is read over SSH, only while its host is awake (it is never woken to be read): a small script on the host prints only the access token and its expiry, so the refresh token never leaves the host. The gateway never refreshes a token, so an idle account whose token has expired shows "no live reading" until a session on it refreshes it; a host that is asleep shows its last reading and its age. With one account the page is as before. The Auto-Dispatch usage card gains an account switcher.

**The board walk** judges each account on its own: see `board-walk.md`, "Dispatch". A Todo runs on its assignee's account. A start on an account recorded at its limit is refused by the gateway, and the Dispatcher is told which accounts are spent when it routes an unassigned Todo.

**Fallback chains per account.** Declare an account in `config.yaml` to give it a chain of its own, as if it were its own Claude installation:

```yaml
engines:
  claude:
    fallback: [codex]              # the default account's chain, unchanged
    accounts:
      friend:
        configDir: /Users/<you>/.claude-friend
        fallback: []               # wait for its own reset
      work2:
        configDir: /Users/<you>/.claude-work2
        fallback: [claude, codex]  # the default account, then codex
        fallbackModelMap: {}
```

- An employee's `claudeConfigDir` matches a declared account by its path. The name labels the account's card. The name is only an alias: renaming it keeps the account's history and limits.
- A chain entry is an engine, `claude` (the default account) or `claude:<name>`. Unknown names and an account naming itself are refused; cycles are allowed.
- A substitute on another account runs on that account's profile, as a fresh session with the recent history in its prompt (a transcript cannot be resumed across profiles). Further turns inside the limit's window stay on it and resume its thread; after the window the session goes back to its own account and thread.
- **Naming `claude:<name>` in `engines.claude.fallback` moves the default account's sessions onto that account when yours is limited, company sessions included**, with everything they load. Only do that with an account that may see your company's context.
- An undeclared profile, or a declared one with no `fallback`, has none. Remote employees keep their engine chain, limited to engines their host can run; account entries apply to local sessions only. A board walk turn never changes engine or account.

## Departments

Each department is a directory under `~/.jinn/org/` containing:

```
~/.jinn/org/engineering/
  department.yaml     # Department metadata
  alice.yaml          # Employee persona
  bob.yaml            # Employee persona
```

### department.yaml

```yaml
name: engineering
displayName: Engineering
description: Builds and maintains the product codebase.
```

`name` must be the directory's name (leave it out and the directory's is used). The file may also say how far the department confines its people:

```yaml
name: side-project
displayName: Side project
description: A friend's side project
scope: scoped              # open (the default, also when absent) | scoped | dedicated
workdirs:                  # scoped and dedicated departments only
  - ~/Projects/side-project
skills: [review]           # company skills copied into a scoped session's directory; [] or absent = none
sharedNotes: [knowledge/shared/glossary.md]   # paths under knowledge/ or docs/ that the department may read
instructions: department   # department | department+company: add the company CLAUDE.md to the department's own
```

| `scope` | Its employees | Everyone else |
|---|---|---|
| `open` | Unrestricted: how every department behaves with no `department.yaml` | Unrestricted |
| `scoped` | Confined to the department | May read, comment on and hold its Todos |
| `dedicated` | Confined to the department | May read and comment, but not hold its Todos |

`workdirs`, `skills`, `sharedNotes` and `instructions` are read only when the scope is not `open`. A working directory must sit inside a git work tree whose top is neither your home directory nor above it, and must not be, contain or lie inside the instance home, `~/.claude`, the gateway's own Claude profile (`CLAUDE_CONFIG_DIR`), any employee's Claude profile (`claudeConfigDir`), `~/.ssh`, `~/.config`, `~/.aws`, `~/.gnupg` or `~/Library`.

**Who holds a Todo.** A Todo's department is its root's: a sub-task is in whatever department its top-level Todo is in.

- A scoped employee (one in a `scoped` or `dedicated` department) holds only its own department's Todos.
- Anyone else holds Todos in any department that is not `dedicated`; a `dedicated` department's Todos are held only by its members.
- `@operator` holds anything.

Every way of setting an assignee checks this (assigning, delegating, the metadata pen, creates from plugins and cron), and so does starting work: the Dispatcher, the board walk and a session linked to a Todo refuse a holder the rules do not allow. Assigning never moves a Todo across a scoped or dedicated department's boundary, in either direction. A sub-task shares its root's department whenever either is scoped or dedicated; moving a top-level Todo across such a boundary moves the sub-tasks that share its department with it, and is refused, naming them, while a sub-task sits in some other department: move those into the top-level Todo's department first. An employee in a scoped or dedicated department must have the department's directory, its immediate directory and its `department` field all agree, or the employee is refused at load and the log says why; move such an employee by moving its file.

**Changes that would strand a holder are refused** and the refusal names each Todo and its holder: making a department `dedicated` while someone outside it holds one of its Todos, scoping a department whose members hold Todos elsewhere, moving a Todo where its holder may not follow, or moving an employee away from Todos it holds. Reassign them first. Scoping a department is also refused, naming them, while one of its members uses another engine than `claude`, or runs on a remote host with a `remoteCwd` over the mount or the department stage directories there, since the scan would otherwise drop that member from the roster. A hand edit to the YAML is not refused; the org scan logs the holdings it leaves outside the rules, and nothing starts on them.

**What a scoped employee can reach.** A session of a scoped employee is bound to its department when it is created, and the gateway holds every request it makes through the jinn tools to that department:

- Todos: lists and searches show only the department's; any other Todo answers exactly as an unknown one does; creates land in the department; relations to Todos outside it show only as a count. Wherever an answer would name a Todo or session outside the department (an event, a run, a comment's session), it shows `hidden` instead.
- Sessions: it sees and messages only sessions bound to its department, plus a live reply to the session that asked it for work. Unscoped sessions, the COO's included, are invisible to it.
- People: the org tools and its prompt show only the department's members, and it can assign, dispatch, delegate and spawn only to them (or assign to `@operator`).
- Notes: its Notes are `knowledge/departments/<slug>/`, plus the department's `sharedNotes`, even when Notes are switched off. Search and reads are rooted there, writes go only into the department's own folder, and the company `knowledge/state.md`, `knowledge/employees/` and `docs/` are out of reach unless shared. The department's own state file is `knowledge/departments/<slug>/state.md`: it is created by the department's first note write, as a title and a `## Current` section of keyed `- key: value` lines, and its sessions keep it through the note tools.
- Files: it may attach or publish only files inside the department's `workdirs` or its stage directory, and cannot browse managed files. On a remote host the files are that host's: its own `remoteCwd` and the department's stage directory there, checked by the jinn tools on that host; attaching by a path the gateway reads is refused.
- Refused: cron, cost, connectors, configuration, global search, the skills API, sprint, label and department administration, and every live socket.

A scoped employee must use the `claude` engine, and may run on a remote host (below); cron jobs cannot target one, and connectors (Telegram) cannot open a session for one. A session whose employee has since left the department, or whose department has been opened, or that was created before its department was scoped, can no longer act or start a turn; start a new one.

**What a scoped session loads.** A scoped session does not run in the instance home. It runs in the department's stage directory, `<parent of the instance home>/.jinn-departments/<slug>/` (`~/.jinn-departments/<slug>/` for `~/.jinn`), which holds only:

- `CLAUDE.md`, generated from `knowledge/departments/<slug>/INSTRUCTIONS.md` (the department's own instructions), then this instance's `CLAUDE.md` when the department says `instructions: department+company`, then a fixed paragraph saying the session is scoped to the department, uses the jinn tools for company state, does not read the instance home, other repositories or other sessions' transcripts with its shell, and keeps its state in `knowledge/departments/<slug>/state.md` through the note tools. With the default `instructions: department`, the company `CLAUDE.md` is not loaded at all.
- `.claude/skills/<name>/`, a copy of each company skill in the department's `skills` list. No list means no company skills. A skill that contains a symlink is refused and logged, and copies nothing. The same list limits what `skills` a Todo in the department can request (set time and dispatch time), and the session's prompt names the skills it has.

Do not edit the stage directory: it is regenerated, file by file, at boot, when a skill, the department's file or its `INSTRUCTIONS.md` changes, and before every scoped session starts, so an edit a session made to it is reverted by the next start, and so is any file a session leaves there: keep work in the department's `workdirs`, not in the session's starting directory. Its path never changes, so resume, fork and compaction keep finding the session's transcript. If it cannot be prepared the session is refused, never started in the instance home. A rate-limited scoped session never moves to another engine: it falls back only to a Claude account in its account's chain, and otherwise waits for its reset. Claude Code also reads instructions from every directory above its working directory, your home directory among them here, so a scoped session's settings tell it to skip every `CLAUDE.md`, `CLAUDE.local.md` and `.claude/` instruction file above the stage directory (`claudeMdExcludes`), and a scoped turn is refused when the installed Claude Code does not know that setting. What follows the Claude profile rather than the directory still loads: the profile's own user-level skills, plugins and settings, and its claude.ai connectors. On the default profile those are yours.

**On a remote host.** A scoped employee may set `remoteHost`, as any employee can. Its sessions then run on that host in a copy of the department's stage directory, `<remote.root>/.jinn-departments/<slug>/`, made by the same generator and synced the same way, file by file, before every scoped session starts there: an edit a session made is reverted, and a copy that was wiped is restored. The employee's own `remoteCwd` is its work area, created if it is missing: the session's prompt names it, and work goes there, not in the stage directory, which the whole department shares. The session's instance home on the host holds only what reaches the gateway, never links into the mounted instance home, and no `CLAUDE.md` is linked into any directory for it. Claude Code also reads the instructions in every directory above its working directory, and an unscoped colleague whose `remoteCwd` is `remote.root` has the company `CLAUDE.md` linked there, so the session's settings tell Claude Code to skip every `CLAUDE.md`, `CLAUDE.local.md` and `.claude/` instruction file above the stage directory (`claudeMdExcludes`); a host whose Claude Code does not know that setting is refused. The gateway applies the department's scope to it exactly as to a local session, and its environment carries `JINN_DEPARTMENT`. Its Claude profile is chosen as for any remote employee (`remoteClaudeConfigDir`, else `remote.claudeConfigDir`). No remote employee, scoped or not, may have a `remoteCwd` that is or lies inside `<remote.root>/.jinn-departments`. A scoped employee's work area must also not contain it, nor be, contain or lie inside `remote.mount`, and `remote.mount` must not overlap `<remote.root>/.jinn-departments`, or the employee is refused at load; nor may the work area or the stage directory overlap the host's own stage directory (`~/.jinn-remote-stage`, which holds every remote session's gateway token), or the session is refused when it starts.

**This is a guardrail, not a sandbox.** It is enforced in the gateway and the jinn tools. A scoped employee's sessions still run as your user with a shell, and a session that deliberately uses that shell can read the instance home, other repositories and credentials, and reach the gateway around the tools. On a remote host the same shell can reach the mounted instance home. Put nothing in a scoped department you would not trust its account with.

**A broken file never opens a department.** Every successful load records the scope. A file that is refused (YAML that does not parse, a `name` that is not the directory's, an unknown `scope`, or a non-open scope on `system` or `org`) or deleted leaves the department at its last recorded scope; one that has never loaded is held as `dedicated` until it does, but only if its text has a `scope:` key with a value other than `open` (so `scope: scopd` counts), or if the file cannot be read at all; otherwise the department stays open, so an old `department.yaml` the parser refuses (earlier templates described one that nothing read) confines no one. The refusal is logged and shown on the department panel either way. Write `scope: open` to open a department. A bad entry in `workdirs`, `skills` or `sharedNotes` is dropped with a warning and the rest of the file still applies. A near-miss name such as `department.yml` is logged and not read.

The org page shows a department's scope as a badge on its group box. Click the box to open the department panel: its details, scope, working directories, skills, shared Notes, instructions, members and the file to edit. Its scope can be changed there; the rest is edited in the file. Sessions bound to a scoped department carry a badge with its name. `GET /api/departments` and `GET /api/departments/:slug` carry the same fields, and `PATCH /api/departments/:slug` (operator only) rewrites the file, keeping keys it does not know but dropping any comments in it, and refuses a scope change that would strand a holder.

### Todos

Todos are deliberately authored work in the live ledger. Employees find and update their assigned Todos, move finished work to in review, and use blocked only when they cannot proceed. Closing, cancelling and archiving Todos are the operator's.

Assigning a Todo, or changing its status, starts nothing. A session starts when the Todo is dispatched (`dispatch_work_item`), or when the scheduled walk over the open Todos starts it from the backlog (its rules file, in the instance home, says what it may start and when). For a multi-step job, split the work into child Todos and delegate them; use cron for scheduled prompts.

### Todo departments

By default a Todo's department is open: any slug a writer names becomes one (and mints its ID prefix), and assigning a Todo moves it into the assignee's org department. To classify Todos by the work instead, close the set in `config.yaml`:

```yaml
gateway:
  todoDepartments:
    allowed: [client, platform, general]
    default: general
```

Then create and the operator's edit pen accept only those slugs, a Todo created without one lands in `default`, and assignment or delegation never changes a Todo's department. Todos already in another department keep it (and their ID) until the operator moves them.

## Ranks

| Rank | Privileges |
|---|---|
| **executive** | Full access. Can message any employee, modify org structure, create departments. {{portalName}} holds this rank. |
| **manager** | Can message employees in their department. Can assign and review department Todos. |
| **senior** | Can message employees in their department. Can update tasks assigned to them. |
| **employee** | Can update tasks assigned to them. |

## Communication

- **Downward**: Higher-ranked agents delegate work through sessions and Todos
- **@mentions**: Messages containing `@name` route to that specific employee
- **Todo-ledger**: Agents check and update their assigned Todos
- **Cross-department**: Executives and managers can delegate across departments when needed

## Default Organization

{{portalName}} ships with a single executive employee:

```yaml
name: {{portalSlug}}
displayName: {{portalName}}
department: executive
rank: executive
engine: claude
model: opus
persona: |
  You are {{portalName}}, the executive AI assistant and gateway administrator.
  You manage the organization, delegate tasks, and handle direct requests.
```
