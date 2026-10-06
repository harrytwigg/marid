# Instance migration bundle: 0.33.3 → 0.34.0

<!-- BEGIN RELEASE RATIONALE -->
Instance doctrine gains a "Long sessions: self-compaction" section in `CLAUDE.md`, placed after "Delegation and ownership": how a session compacts itself with `compact_session` and a handoff, when to use it and when not to, what happens to delegation in flight, and how opt-in auto-compaction behaves. The reference docs (`architecture`, `connectors`, `cron`, `org`, `overview`, `self-modification`) are brought in line with the code, and five shipped skills get matching corrections.

An instance that already added its own self-compaction section by hand has the same heading as the stock section. Keep one copy: reconcile the wording into the existing section rather than appending a second. Treat a disagreement between the two as a conflict to review, not as new stock content.

Experiments and Workflows are removed. `CLAUDE.md`, the reference docs and the shipped skills drop them; `skills/experiments`, `skills/workflow` and `scripts/workflow-triggers/README.md` are removed, and the gateway retires the two skills on its next template sync. An instance that customised either skill keeps a backup under `.migration-backups/`; it should not restore them, because the tools they describe no longer exist.

The Todo model changes with them, and the docs and skills say so: the statuses `assigned` and `escalated` are gone, agents can no longer close, reopen or archive a Todo, approvals are gone (a decision that needs a person is a Todo stopped in `blocked` with a comment, and finished work is handed over in `in_review` with a summary), and comments are the record: an `@employee` mention wakes that employee on the Todo, a reply reaches the session whose comment it answers, and a comment that does neither wakes no one. An instance whose own `CLAUDE.md` tells employees to request approvals or to rely on Workflows should be reconciled to that model rather than keep the old wording; flag it as a conflict where its wording differs.

Shipped skills are rewritten from the template on every gateway start, so the `skills/` records here are informational; `CLAUDE.md` and `docs/` are never rewritten automatically and need this merge.

The board walk replaces the idle-capacity auto-start. `docs/company-doctrine.md`, `docs/org.md` and the `todo-handling` skill now say that work starts on a dispatch or when the board walk starts it from the backlog. `board-walk.md` is new. The gateway itself creates it at the first boot of this version when it is missing, converting any `gateway.idleCapacity` block into its prose. So the `board-walk.md` record here is informational: never create, overwrite or merge into an instance's existing `board-walk.md`. Its wording is the operator's, and it may have been converted from their old settings. When the walk runs is not in that file: the gateway also adds a `board-walk` cron job to `cron/jobs.json` (with `"action": "board-walk"`) at that boot, carrying over any `enabled`, `schedule` and `timezone` an earlier `board-walk.md` held and taking them out of its frontmatter. `docs/cron.md` and the `cron-manager` skill describe action jobs. Never add or remove that cron job as part of this migration, and never put the schedule keys back into `board-walk.md`.

The `no-auto-start` label is retired: `autoStart: false` on a Todo's dispatch config (`create_work_item { autoStart: false }`, `set_work_item_dispatch`, or the Auto-start switch on the Todo's page) is the only per-Todo auto-start opt-out, and the `todo-handling` skill says so. The gateway carries the data itself: at boot it sets `autoStart: false` on every Todo still carrying the label, removes the label from them and deletes it. Instance-owned text is not covered by that. An instance whose own `CLAUDE.md`, `AGENTS.md`, docs, Notes, personas, local skills or cron prompts tell employees to add the `no-auto-start` label should be reconciled to `autoStart: false`; flag it as a conflict where its wording differs.

Sprints are new. The `todo-handling` skill gains one line on the `sprint` filter on `list_work_items` and the `sprint` field on `create_work_item` and `edit_work_item`; like every shipped skill it is rewritten from the template, so that record is informational. Nothing in an instance's own files has to change for sprints: the gateway creates the `sprints` and `work_item_sprints` tables at boot, every existing Todo starts in no sprint, and the board looks as it did until the operator creates one.

Employees can run on their own Claude Code profile. `docs/org.md` gains a `claudeConfigDir` row in the employee fields table and a "Claude profiles" section: how to sign a profile in and set the field, the signed-in check, what goes to that profile's account, and how its limits are kept apart. Merge that into the instance's `docs/org.md`. Nothing else in an instance has to change. With no `claudeConfigDir` on any employee, every session runs on the gateway's own profile exactly as before, and the gateway keeps the default account's state files and keys as they are. To opt in, sign the profile in once on the gateway's machine (`CLAUDE_CONFIG_DIR=<dir> claude`, then `/login`) and set `claudeConfigDir: <dir>` on the employee's YAML, written exactly as signed in. Be clear about what that sends: an employee on a profile sends everything its sessions load, the company `CLAUDE.md`, skills and `knowledge/state.md` included, to that profile's account, because a profile is independent of department scope.

Departments can carry a scope. `docs/org.md` documents the new `department.yaml` keys (`scope`, `workdirs`, `skills`, `sharedNotes`, `instructions`) and what a scope does in this release: assignment never moves a Todo into or out of a scoped or dedicated department, a sub-task shares its root's department across that boundary, an employee whose directory and `department` field disagree about a scoped department is refused at load, and a refused or deleted `department.yaml` keeps the department's last scope. `docs/org.md` is never rewritten automatically, so merge its Departments section by heading into the instance's own copy; the `management` skill gains a matching "Scope a department" section, which is informational because shipped skills are rewritten from the template. The gateway does the rest at boot: it creates the `department_scopes` table in the Todo database, and records a department's scope the first time its `department.yaml` loads. Earlier templates described a `department.yaml` that nothing read, so an instance may already hold one. Validate every `org/*/department.yaml` as YAML before restarting (a description with an unquoted colon does not parse, and a `name` must be the directory's); a file the parser refuses leaves its department open, with the refusal in the log and on the department panel, unless its own text has a `scope:` key with a value other than `open` (a typo included) or the file cannot be read at all, in which case the department is held dedicated until the file loads. An instance with no `department.yaml` that sets a scope needs nothing else, because every department stays `open` and nothing about assignment, sub-tasks or employee loading changes. To opt in, write `scope: scoped` or `scope: dedicated` in `org/<department>/department.yaml` and keep that department's employees in `org/<department>/` with a matching `department:` field. The department panel and `PATCH /api/departments/:slug` can set a scope too (next paragraph).

Scoped employees are enforced in this release. An employee in a `scoped` or `dedicated` department is confined to it through the jinn tools: its sessions are bound to the department when they are created, and the gateway holds every request they make to that department's Todos, members, bound sessions and its own Notes under `knowledge/departments/<slug>/`, and refuses cron, cost, connectors, configuration, global search, the skills API and live sockets. Who may hold a Todo is enforced too: a scoped employee holds only its own department's Todos, and only members hold a `dedicated` department's. `docs/org.md`'s Departments section is rewritten to say so (who holds a Todo, the refusals that name stranded holders, what a scoped employee can reach, and that this is a guardrail on the tools rather than a sandbox); merge it by heading into the instance's copy, and reconcile `docs/company-doctrine.md`'s "One Interface (MCP)" section, which gains a paragraph on it. The `todo-handling`, `delegation` and `management` skills gain matching text; those records are informational because shipped skills are rewritten from the template. The gateway adds a `scope_department` column to the sessions table at boot. An instance with no `department.yaml` that sets a scope needs nothing else: no session is bound and every route answers as before. An instance that already set a scope by hand in this release's earlier form, or that opts in now, should check before restarting or scoping: each employee of a scoped or dedicated department must use the `claude` engine (the scan refuses it otherwise, and says why; a remote one is covered below), no `cron/jobs.json` job may target one, and no Todo should be held across the boundary (the org scan logs any such holding, and nothing starts on it; the API refuses a scope change that would create one, naming the holders). A session that existed before its employee's department was scoped has no binding and is refused until a new session is started. Scoped sessions no longer load the instance's `CLAUDE.md`, skills or `knowledge/state.md` (next paragraph), so an instance whose own `CLAUDE.md` tells every session to read `knowledge/state.md` through the tools should expect scoped sessions to be refused it. To opt in, set `scope: scoped` or `scope: dedicated` in `org/<department>/department.yaml` or from the department panel.

A scoped session now loads only its department's context. It runs in a generated directory, `<parent of the instance home>/.jinn-departments/<slug>/` (`~/.jinn-departments/<slug>/` for `~/.jinn`), outside the instance home, holding a `CLAUDE.md` built from `knowledge/departments/<slug>/INSTRUCTIONS.md` and a copy of each skill in the department's `skills` list. The company `CLAUDE.md` is added to it only when the department sets `instructions: department+company`, and the department's own `CLAUDE.md` always ends with a fixed paragraph saying the session is scoped, uses the jinn tools for company state, does not read the instance home with its shell and keeps its state in `knowledge/departments/<slug>/state.md`. The gateway creates and syncs the directory by itself at boot and before every scoped session; it asks nothing of the instance, and it never deletes the directory when a department is opened. Two instances under the same parent directory (for example `~/.jinn` and `~/.jinn-staging`) share one `.jinn-departments/`, so give a department a different slug in each if both scope it. A department's Notes and state are `knowledge/departments/<slug>/`: write the department's instructions in `INSTRUCTIONS.md` there (a scoped session can also write into that folder), and the department's `state.md` is created by its first note write. The skill list also limits the `skills` a Todo in the department can request; a Todo that already names skills the department does not allow is dispatched without them, and fails at dispatch with the reason when none of them is allowed. `docs/org.md`'s Departments section gains "What a scoped session loads" and the state-file text, and `docs/company-doctrine.md`, and the `todo-handling` and `management` skills, a sentence each; merge `docs/org.md` and `docs/company-doctrine.md` by heading into the instance's copies, and treat the skill records as informational because shipped skills are rewritten from the template. An instance with no scoped department needs nothing else. An instance with one should, before restarting, write the department's `INSTRUCTIONS.md` and list the skills its sessions need in `skills` (a scoped session has no company skills otherwise), and move anything its sessions used to read from the company `CLAUDE.md` into either. A session that was running before the upgrade keeps its old transcript under the instance home, so start a new one. To opt in, set `scope: scoped` or `scope: dedicated` in `org/<department>/department.yaml`, then fill `skills` and `instructions`.

Scoped employees can run on remote hosts. A scoped employee with a `remoteHost` was refused; it now runs on that host in `<remote.root>/.jinn-departments/<slug>/`, a copy of the department's stage directory that the gateway syncs there, file by file, before every scoped session starts, and its own `remoteCwd` becomes its work area, named in the session's prompt. Its instance home on the host links nothing from the mounted instance home, and no `CLAUDE.md` is linked into any directory for it; unscoped remote employees are staged exactly as before. `docs/org.md`'s Departments section gains an "On a remote host" paragraph, and the "Files" line, the scoped-employee rules and the refusal list change with it; merge them by heading into the instance's copy. The `management` skill's sentence changes too; that record is informational, because shipped skills are rewritten from the template. The gateway does everything else by itself: it creates `<remote.root>/.jinn-departments/` on a host the first time a scoped member runs there, and nothing in the registry changes. An instance with no scoped employee on a remote host needs nothing. Before giving a scoped employee a `remoteHost`, check that its `remoteCwd` sits under `remote.root` and is not, does not contain and does not lie inside `<remote.root>/.jinn-departments` or `remote.mount`, and that `remote.mount` does not overlap `<remote.root>/.jinn-departments` (the scan refuses the employee otherwise, and says why), and keep the work area clear of the host's `~/.jinn-remote-stage` (a spawn is refused otherwise). Check too that no remote employee, scoped or not, has a `remoteCwd` inside `<remote.root>/.jinn-departments` (the scan refuses it now), and that the host's Claude Code knows the `claudeMdExcludes` setting, which a scoped session uses to skip the instructions above its stage directory (the spawn is refused otherwise; update Claude Code there). An employee that ran unscoped on the host before its department was scoped has a `CLAUDE.md` link to the mounted instance home left in its `remoteCwd`; the scoped session does not read it from there, but remove it. The session's shell on the host can still reach the mounted instance home: this is the same guardrail as locally, not a sandbox.

Limits, auto-dispatch and fallback are now judged per Claude account: the gateway's own profile, each local named profile and each remote host's login. `docs/org.md` gains a "Claude accounts" section (account keys, the Limits page per account, the board walk per account, and fallback chains declared under `engines.claude.accounts`) and an updated "Limits" paragraph under "Claude profiles"; `docs/architecture.md` gains an "Accounts" section. Merge both into the instance's docs. The shipped `board-walk.md` Dispatch section now states every rule per account: the allowance thresholds, "hold, never guess", the concurrency rule and one start per tick, each for each account, plus the one probing start for an account with no live reading and the unrouted-Todo limit. The instance's own `board-walk.md` is still never created, overwritten or merged automatically: reconcile its Dispatch prose to the per-account wording by hand, keep the operator's own numbers and rules, and flag any wording that differs from the stock text as a conflict for the operator rather than replacing it. Until it is reconciled the walk still runs; the gateway refuses a start on an exhausted account in code either way. The gateway does the rest by itself at boot: per-account limit state goes in new files beside the existing ones (a usage history per account under `tmp/engine-limits/`, per-account records inside `tmp/engine-health.json` and `tmp/claude-usage.json`, and `priorFiveHourByAccount` in `state/board-walk.json`); the default account keeps its files and keys. An instance with no `claudeConfigDir`, no remote Claude employee and no `engines.claude.accounts` needs nothing else: its Limits page, usage card and board walk answer exactly as before. A remote Claude employee's limit is now its own login's rather than the default account's. To opt in to per-account fallback, declare each profile under `engines.claude.accounts.<name>` with its `configDir` and an optional `fallback` chain; naming `claude:<name>` in `engines.claude.fallback` moves the default account's sessions, company context included, onto that account when the default is limited.
<!-- END RELEASE RATIONALE -->

This file is generated. The manifest is authoritative; each record below appears exactly once.
Each record names only inputs that ship in this bundle or exist in the instance: the base payload under `files/base/` is the generic template before this release, the target payload under `files/target/` is the template after it, both relative to this bundle directory, and the current user-owned file is the instance path shown on the record.
Materialize those payloads before comparing: in `.md`, `.yaml` and `.yml` files replace `{{portalName}}` with the instance's `portal.portalName` from `config.yaml` (default `Jinn`) and `{{portalSlug}}` with that name lowercased with runs of whitespace replaced by single hyphens, and leave every other file byte-for-byte unchanged.
Then three-way merge the materialized base, the current instance file and the materialized target; preserve user customizations, record unresolved placeholders as conflicts, and never delete user content without explicit review and a snapshot.
Merge Markdown by heading. When the target adds a section whose heading the instance file already has, reconcile it into that existing section and record a conflict where the wording differs; never append a second section with the same heading.

## `CLAUDE.md`

- Operation: `modify`
- Base payload: `files/base/CLAUDE.md`
- Target payload: `files/target/CLAUDE.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `CLAUDE.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `board-walk.md`

- Operation: `add`
- Base payload: none (file did not exist)
- Target payload: `files/target/board-walk.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `board-walk.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/architecture.md`

- Operation: `modify`
- Base payload: `files/base/docs/architecture.md`
- Target payload: `files/target/docs/architecture.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `docs/architecture.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/company-doctrine.md`

- Operation: `modify`
- Base payload: `files/base/docs/company-doctrine.md`
- Target payload: `files/target/docs/company-doctrine.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `docs/company-doctrine.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/connectors.md`

- Operation: `modify`
- Base payload: `files/base/docs/connectors.md`
- Target payload: `files/target/docs/connectors.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `docs/connectors.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/cron.md`

- Operation: `modify`
- Base payload: `files/base/docs/cron.md`
- Target payload: `files/target/docs/cron.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `docs/cron.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/mcp.md`

- Operation: `modify`
- Base payload: `files/base/docs/mcp.md`
- Target payload: `files/target/docs/mcp.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `docs/mcp.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/org.md`

- Operation: `modify`
- Base payload: `files/base/docs/org.md`
- Target payload: `files/target/docs/org.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `docs/org.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/overview.md`

- Operation: `modify`
- Base payload: `files/base/docs/overview.md`
- Target payload: `files/target/docs/overview.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `docs/overview.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/self-modification.md`

- Operation: `modify`
- Base payload: `files/base/docs/self-modification.md`
- Target payload: `files/target/docs/self-modification.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `docs/self-modification.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/skills.md`

- Operation: `modify`
- Base payload: `files/base/docs/skills.md`
- Target payload: `files/target/docs/skills.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `docs/skills.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `scripts/workflow-triggers/README.md`

- Operation: `remove`
- Base payload: `files/base/scripts/workflow-triggers/README.md`
- Target payload: none (file is removed from stock)
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `scripts/workflow-triggers/README.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/cron-manager/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/cron-manager/SKILL.md`
- Target payload: `files/target/skills/cron-manager/SKILL.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `skills/cron-manager/SKILL.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/delegation/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/delegation/SKILL.md`
- Target payload: `files/target/skills/delegation/SKILL.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `skills/delegation/SKILL.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/experiments/SKILL.md`

- Operation: `remove`
- Base payload: `files/base/skills/experiments/SKILL.md`
- Target payload: none (file is removed from stock)
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `skills/experiments/SKILL.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/management/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/management/SKILL.md`
- Target payload: `files/target/skills/management/SKILL.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `skills/management/SKILL.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/self-heal/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/self-heal/SKILL.md`
- Target payload: `files/target/skills/self-heal/SKILL.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `skills/self-heal/SKILL.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/todo-handling/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/todo-handling/SKILL.md`
- Target payload: `files/target/skills/todo-handling/SKILL.md`
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `skills/todo-handling/SKILL.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/workflow/SKILL.md`

- Operation: `remove`
- Base payload: `files/base/skills/workflow/SKILL.md`
- Target payload: none (file is removed from stock)
- Merge instruction: materialize the base and target payloads named above with this instance's values, then three-way merge them against the current instance path `skills/workflow/SKILL.md` (a missing base means the file is new, a missing target means it is removed from stock); preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.
