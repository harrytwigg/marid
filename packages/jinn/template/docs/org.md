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

The `remote*` fields need a `remote` block in `config.yaml`. A bad remote target is refused at load: that one employee is skipped and the rest of the org still loads.

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

Todos are deliberately authored work in the live ledger. Employees find and update their assigned Todos, move finished work to in review, and use blocked or escalated only when they cannot proceed.

Assigning a Todo, or changing its status, starts nothing. A session starts when the Todo is dispatched (`dispatch_work_item`), or when idle capacity is enabled and its sweep picks the Todo from the backlog. For a multi-step job, split the work into child Todos and delegate them; use cron for scheduled prompts.

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
