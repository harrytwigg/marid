# Instance migration bundle: 0.33.3 → 0.34.0

<!-- BEGIN RELEASE RATIONALE -->
Instance doctrine gains a "Long sessions: self-compaction" section in `CLAUDE.md`, placed after "Delegation and ownership": how a session compacts itself with `compact_session` and a handoff, when to use it and when not to, what happens to delegation in flight, and how opt-in auto-compaction behaves. The reference docs (`architecture`, `connectors`, `cron`, `org`, `overview`, `self-modification`) are brought in line with the code, and five shipped skills get matching corrections.

An instance that already added its own self-compaction section by hand has the same heading as the stock section. Keep one copy: reconcile the wording into the existing section rather than appending a second. Treat a disagreement between the two as a conflict to review, not as new stock content.

Shipped skills are rewritten from the template on every gateway start, so the `skills/` records here are informational; `CLAUDE.md` and `docs/` are never rewritten automatically and need this merge.

The board walk replaces the idle-capacity auto-start. `docs/company-doctrine.md`, `docs/org.md` and the `todo-handling` skill now say that work starts on a dispatch or when the board walk starts it from the backlog. `board-walk.md` is new. The gateway itself creates it at the first boot of this version when it is missing, converting any `gateway.idleCapacity` block into its prose. So the `board-walk.md` record here is informational: never create, overwrite or merge into an instance's existing `board-walk.md`. Its wording is the operator's, and it may have been converted from their old settings.
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
