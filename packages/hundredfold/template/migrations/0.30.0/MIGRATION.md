# Instance migration bundle: 0.29.1 → 0.30.0

<!-- BEGIN RELEASE RATIONALE -->
This release bundle was generated from the exact instance-template delta.
<!-- END RELEASE RATIONALE -->

This file is generated. The manifest is authoritative; each record below appears exactly once.
The payload paths below are generic package sources. Before review, the gateway creates audited, read-only materialized base payload and materialized target payload copies beneath the instance migration snapshot using that instance's exact template replacements.
Perform the three-way merge only from those materialized snapshot payloads and the current user-owned instance file. Never apply a raw generic payload or copy an unresolved placeholder into the instance. Preserve user customizations and never delete user content without explicit review and a snapshot.

## `CLAUDE.md`

- Operation: `modify`
- Base payload: `files/base/CLAUDE.md`
- Target payload: `files/target/CLAUDE.md`
- Merge instruction: compare the audited materialized base with the current instance path `CLAUDE.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/architecture.md`

- Operation: `modify`
- Base payload: `files/base/docs/architecture.md`
- Target payload: `files/target/docs/architecture.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/architecture.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/company-doctrine.md`

- Operation: `modify`
- Base payload: `files/base/docs/company-doctrine.md`
- Target payload: `files/target/docs/company-doctrine.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/company-doctrine.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/cron.md`

- Operation: `modify`
- Base payload: `files/base/docs/cron.md`
- Target payload: `files/target/docs/cron.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/cron.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/mcp.md`

- Operation: `modify`
- Base payload: `files/base/docs/mcp.md`
- Target payload: `files/target/docs/mcp.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/mcp.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/org.md`

- Operation: `modify`
- Base payload: `files/base/docs/org.md`
- Target payload: `files/target/docs/org.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/org.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/overview.md`

- Operation: `modify`
- Base payload: `files/base/docs/overview.md`
- Target payload: `files/target/docs/overview.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/overview.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/skills.md`

- Operation: `modify`
- Base payload: `files/base/docs/skills.md`
- Target payload: `files/target/docs/skills.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/skills.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/cron-manager/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/cron-manager/SKILL.md`
- Target payload: `files/target/skills/cron-manager/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/cron-manager/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/delegation/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/delegation/SKILL.md`
- Target payload: `files/target/skills/delegation/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/delegation/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/experiments/SKILL.md`

- Operation: `add`
- Base payload: none (file did not exist)
- Target payload: `files/target/skills/experiments/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/experiments/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

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

## `skills/notes/SKILL.md`

- Operation: `add`
- Base payload: none (file did not exist)
- Target payload: `files/target/skills/notes/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/notes/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/onboarding/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/onboarding/SKILL.md`
- Target payload: `files/target/skills/onboarding/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/onboarding/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/self-heal/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/self-heal/SKILL.md`
- Target payload: `files/target/skills/self-heal/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/self-heal/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

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
