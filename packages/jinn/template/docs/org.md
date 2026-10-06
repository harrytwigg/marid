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

**Limits.** Each profile is its own account. Its usage limit and its login failures hold back only its own sessions, and yours hold back only yours. A profile's session has no fallback engine: when it hits its limit it waits for its own reset, whatever `engines.claude.fallback` says. The Limits page and the board walk still read only your own account.

Two employees may share one profile, and then they share its limits. `remoteClaudeConfigDir` is the remote equivalent, and the remote employee keeps the engine fallback chain.

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
