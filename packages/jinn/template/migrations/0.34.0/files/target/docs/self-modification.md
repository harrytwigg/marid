# Self-Modification

{{portalName}}'s engines operate within `~/.jinn/` and can modify any file in that directory. This enables {{portalName}} to update its own configuration, create skills, manage cron jobs, and restructure the organization at runtime.

## What {{portalName}} Can Edit

| File/Directory | Effect of Modification |
|---|---|
| `config.yaml` | File watcher triggers a config reload (not every key; see below) |
| `cron/jobs.json` | File watcher triggers cron reschedule |
| `org/**/*.yaml` | File watcher triggers employee registry rebuild |
| `skills/<name>/` added or removed | File watcher re-syncs the `.claude/skills/` and `.agents/skills/` links and notifies clients |
| `skills/*/SKILL.md` | Read on demand by engines; edits need no watcher |
| `skills/**/*` | Supporting skill data; read on demand |
| `plugins/**` | File watcher rescans installed plugins |

## File Watcher Reactions

The gateway uses chokidar to watch for changes:

- **config.yaml** → Re-read the configuration in memory: sessions, the model and capability registry and the built-in `jinn` MCP gate pick up the new values, as does the plugin enable/disable state. The listening `port` and `host` and the `logging` settings are applied once at startup, and running connectors are not restarted by a config edit (`POST /api/connectors/reload` does that)
- **cron/jobs.json** → Parse JSON, validate each job, reschedule the valid ones (an invalid job is skipped with a warning, not allowed to block the rest)
- **org/\*\*/\*.yaml** → Rebuild the employee registry from all persona and department YAML files
- **skills/** (top level only) → Re-sync the skill links and tell connected clients
- **plugins/** → Rescan installed plugins

These reloads take effect without a restart. A changed `port`, `host` or `logging` setting needs `jinn restart`: they are applied once at startup.

## Safety Guidelines

Engines have full file access within `~/.jinn/`. To avoid breaking the gateway:

### Do

- Validate YAML before writing to `config.yaml` (must be valid YAML with expected schema)
- Validate JSON before writing to `jobs.json` or other structured state files
- Use atomic writes (write to temp file, then rename) for critical files
- Back up files before making destructive changes
- Test cron expressions before adding them to `jobs.json`

### Do Not

- Break `config.yaml` structure - invalid YAML will prevent config reload
- Corrupt `sessions/registry.db` - the SQLite database is managed by the gateway process
- Write invalid JSON to `jobs.json` - this will cancel all cron jobs with nothing to replace them
- Delete the `docs/` directory - these reference docs are needed for self-awareness
- Modify files outside `~/.jinn/` unless explicitly instructed by the user

## Example: Creating a Cron Job at Runtime

An engine can create a new cron job by reading `cron/jobs.json`, appending a new entry, and writing it back:

```
1. Read ~/.jinn/cron/jobs.json
2. Parse the JSON array
3. Append new job object with unique id, schedule, prompt, etc.
4. Validate the full array
5. Write back to ~/.jinn/cron/jobs.json
6. The file watcher automatically reschedules all jobs
```

## Example: Adding a New Employee

```
1. Create ~/.jinn/org/<department>/<name>.yaml with required fields
2. The file watcher detects the new file and rebuilds the employee registry
3. The new employee is immediately available for @mention routing
```
