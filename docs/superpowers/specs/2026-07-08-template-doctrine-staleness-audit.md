# Template Doctrine Staleness Audit

**Scope:** Active shipped template surface under `packages/hundredfold/template/`, with special attention to delegation doctrine, MCP-first operations, Todos/Workflows wording, placeholders, dead references, and bundled skill consistency.

## Findings

### Raw session/org HTTP in active skills

Fix: `skills/management/SKILL.md` taught promoted managers to use raw session/org endpoints and described child sessions as a gateway API. Replaced those instructions with `hundredfold_delegate_task`, `hundredfold_spawn_session`, `hundredfold_send_to_session`, `hundredfold_read_session`, `hundredfold_list_employees`, `hundredfold_find_employees`, and `hundredfold_get_employee`; added end-turn-after-spawn discipline and the orchestrate-at-scale stance.

Fix: `skills/onboarding/SKILL.md` used raw child-session creation with parent linkage in the live delegation demo. Replaced it with `hundredfold_spawn_session` and explicit callback/read discipline.

Fix: `skills/sync/SKILL.md` used raw session/org fetches. Replaced it with `hundredfold_list_sessions`, `hundredfold_read_session`, and org discovery tools. Also removed the unbounded full-transcript assumption because `hundredfold_read_session` is intentionally capped.

### Shared doctrine gaps

Fix: `CLAUDE.md` now makes callback/end-turn discipline universal to any session at any depth, including nested chains such as COO -> lead -> pod -> sub-report.

Fix: `CLAUDE.md` now distinguishes Employees from Sub-agents and folds the old agent-teams concept into that framing.

Fix: `CLAUDE.md` now codifies the domain-agnostic PLAN -> REFINE -> IMPLEMENT -> REVIEW -> VERIFY loop, independent reviewers, Todo `in_review` handling, round caps, orchestration default, and bounded autonomous execution.

### Talk-specific HTTP surface

Defer: `talk/card-reference.md` and `talk/orchestrator-persona.md` still name `/api/talk/*` endpoints. This is an intentional talk-mode exception, not deprecated company/session/org operation. The talk surface currently has no equivalent Hundredfold MCP card/delegate/search tools, and the files explicitly prohibit direct `/api/sessions` use.

### Historical migrations

Defer: `template/migrations/**` contains old `/api/*`, board, and `in_progress` language as historical migration documentation and frozen migration payloads. These are not active prompt doctrine for new sessions. Updating them would rewrite history and risk confusing migration provenance.

### Todos vs legacy boards

Fix: Active `CLAUDE.md`, docs, and bundled skills remain on Todos/Workflows. No active `board.json`, board-status, or `in_progress` drift remains outside historical migrations.

### Placeholder integrity

Fix: Active template doctrine keeps shipped user/instance wording generic and placeholder-based (`{{portalName}}`, `{{portalSlug}}`, `{{operatorName}}`) where personalization is required. No operator/project/private path leak was found in active template files.

### Skill references

Fix: Skills listed in `CLAUDE.md` exist under `template/skills/`: `management`, `cron-manager`, `skill-creator`, `self-heal`, and `onboarding`.

Defer: `skills.json` contains an empty `installed` registry. That matches the current bundled-skill model: bundled skills are shipped as directories, while `skills.json` tracks extra installed registry skills. No directory list should be duplicated there unless the installer contract changes.

## Follow-up Gaps

Defer: There is no MCP org-write tool for creating/editing/removing employee YAML files, so `management` still uses local file edits for roster mutation. The MCP-first contract allows filesystem work when no MCP tool covers the operation. A future `hundredfold_create_employee` / `hundredfold_update_employee` / `hundredfold_delete_employee` tool would let the management skill become fully company-tool driven.

Defer: There are no MCP tools for the talk card surface. A future `hundredfold_talk_card_*` group would let talk prompts stop naming `/api/talk/*` endpoints.
