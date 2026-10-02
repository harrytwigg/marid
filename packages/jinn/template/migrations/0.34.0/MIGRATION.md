# Instance migration bundle: 0.33.3 → 0.34.0

<!-- BEGIN RELEASE RATIONALE -->
Instance doctrine gains a "Long sessions: self-compaction" section in `CLAUDE.md`, placed after "Delegation and ownership": how a session compacts itself with `compact_session` and a handoff, when to use it and when not to, what happens to delegation in flight, and how opt-in auto-compaction behaves. The reference docs (`architecture`, `connectors`, `cron`, `org`, `overview`, `self-modification`) are brought in line with the code, and five shipped skills get matching corrections.

An instance that already added its own self-compaction section by hand has the same heading as the stock section. Keep one copy: reconcile the wording into the existing section rather than appending a second. Treat a disagreement between the two as a conflict to review, not as new stock content.

Shipped skills are rewritten from the template on every gateway start, so the `skills/` records here are informational; `CLAUDE.md` and `docs/` are never rewritten automatically and need this merge.
<!-- END RELEASE RATIONALE -->

This file is generated. The manifest is authoritative; each record below appears exactly once.
The payload paths below are generic package sources. Before review, the gateway creates audited, read-only materialized base payload and materialized target payload copies beneath the instance migration snapshot using that instance's exact template replacements.
Perform the three-way merge only from those materialized snapshot payloads and the current user-owned instance file. Never apply a raw generic payload or copy an unresolved placeholder into the instance. Preserve user customizations and never delete user content without explicit review and a snapshot.
Merge Markdown by heading. When the target adds a section whose heading the instance file already has, reconcile it into that existing section and record a conflict where the wording differs; never append a second section with the same heading.

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

## `docs/connectors.md`

- Operation: `modify`
- Base payload: `files/base/docs/connectors.md`
- Target payload: `files/target/docs/connectors.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/connectors.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `docs/cron.md`

- Operation: `modify`
- Base payload: `files/base/docs/cron.md`
- Target payload: `files/target/docs/cron.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/cron.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

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

## `docs/self-modification.md`

- Operation: `modify`
- Base payload: `files/base/docs/self-modification.md`
- Target payload: `files/target/docs/self-modification.md`
- Merge instruction: compare the audited materialized base with the current instance path `docs/self-modification.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/cron-manager/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/cron-manager/SKILL.md`
- Target payload: `files/target/skills/cron-manager/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/cron-manager/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

## `skills/management/SKILL.md`

- Operation: `modify`
- Base payload: `files/base/skills/management/SKILL.md`
- Target payload: `files/target/skills/management/SKILL.md`
- Merge instruction: compare the audited materialized base with the current instance path `skills/management/SKILL.md` and the audited materialized target; preserve customized content, record unresolved placeholders as conflicts, and verify the result before completion.

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
