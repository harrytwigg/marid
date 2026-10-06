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

Departments can carry a scope. `docs/org.md` documents the new `department.yaml` keys (`scope`, `workdirs`, `skills`, `sharedNotes`, `instructions`) and what a scope does in this release: assignment never moves a Todo into or out of a scoped or dedicated department, a sub-task shares its root's department across that boundary, an employee whose directory and `department` field disagree about a scoped department is refused at load, and a refused or deleted `department.yaml` keeps the department's last scope. Nobody is confined yet. `docs/org.md` is never rewritten automatically, so merge its Departments section by heading into the instance's own copy; the `management` skill gains a matching "Scope a department" section, which is informational because shipped skills are rewritten from the template. The gateway does the rest at boot: it creates the `department_scopes` table in the Todo database, and records a department's scope the first time its `department.yaml` loads. Earlier templates described a `department.yaml` that nothing read, so an instance may already hold one. Validate every `org/*/department.yaml` as YAML before restarting (a description with an unquoted colon does not parse, and a `name` must be the directory's); a file the parser refuses leaves its department open, with the refusal in the log and on the department panel, unless its own text asks for `scope: scoped` or `scope: dedicated`, in which case the department is held dedicated until the file loads. An instance with no `department.yaml` that sets a scope needs nothing else, because every department stays `open` and nothing about assignment, sub-tasks or employee loading changes. To opt in, write `scope: scoped` or `scope: dedicated` in `org/<department>/department.yaml` and keep that department's employees in `org/<department>/` with a matching `department:` field. The API refuses to set a scope other than `open` until scoped employees are enforced in a later release, so the file is the only way to set one.
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
