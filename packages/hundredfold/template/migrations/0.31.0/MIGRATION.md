# Instance migration bundle: 0.30.1 → 0.31.0

<!-- BEGIN RELEASE RATIONALE -->
Five instance files changed in 0.31.0, all of them agent-facing doctrine.

`skills.json` moves from an object with an `installed` map to a flat array; an instance that
customized it must carry its entries across the shape change rather than merge in place.

`skills/todo-handling/SKILL.md` and `skills/management/SKILL.md` record two behavior changes
agents will otherwise get wrong: `create_work_item` no longer accepts an assignee, so assignment
is always a second `assign_work_item` call, and done/cancelled/escalated are now sticky — only the
top-level orchestrator session may release one, via `asOperator: true`.

`skills/workflow/SKILL.md` documents the new `workflow-call` node type and its bounded `iterate`
form (`maxRounds`, `continueWhile`, the `exhausted` exit).

`skills/find-and-install/SKILL.md` follows the `skills.json` shape change.
<!-- END RELEASE RATIONALE -->

This file is generated. The manifest is authoritative; each record below appears exactly once.
The payload paths below are generic package sources. Before review, the gateway creates audited, read-only materialized base payload and materialized target payload copies beneath the instance migration snapshot using that instance's exact template replacements.
Perform the three-way merge only from those materialized snapshot payloads and the current user-owned instance file. Never apply a raw generic payload or copy an unresolved placeholder into the instance. Preserve user customizations and never delete user content without explicit review and a snapshot.

## `skills.json`

- Operation: `modify`
- Base payload: `files/base/skills.json`
- Target payload: `files/target/skills.json`
- Merge instruction: compare the audited materialized base with the current instance path `skills.json` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/find-and-install/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/find-and-install/SKILL.md`
- Target payload: `files/target/skills/find-and-install/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/find-and-install/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/management/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/management/SKILL.md`
- Target payload: `files/target/skills/management/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/management/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/todo-handling/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/todo-handling/SKILL.md`
- Target payload: `files/target/skills/todo-handling/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/todo-handling/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/workflow/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/workflow/SKILL.md`
- Target payload: `files/target/skills/workflow/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/workflow/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.
