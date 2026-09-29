# Specification Quality Checklist: Remote MCP Connector

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-23
**Feature**: [spec.md](../spec.md)

## Content Quality

- [ ] No implementation details (languages, frameworks, APIs). Deliberately failed, see Notes
- [x] Focused on user value and business needs
- [ ] Written for non-technical stakeholders. Deliberately failed, see Notes
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (Q1 and Q2 answered 2026-09-23)
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [ ] No implementation details leak into specification. Deliberately failed, see Notes

## Notes

- **Two markers remain, deliberately**: Q1 (auth mode) and Q2 (which tool classes).
  Both are security and scope calls for the operator. Each has a stated recommendation.
  Q3 (principal attribution) has a default and needs an answer only if the operator
  disagrees. `/speckit-plan` waits on Q1 and Q2.
- **Implementation detail, deliberately kept.** The spec names transports (streamable HTTP),
  protocol headers and Cloudflare features where they *are* the requirement. The operator's
  brief framed the feature in those terms, and a connector spec that avoided naming MCP or
  the tunnel would not be testable. The security requirements (FR-006, FR-007, FR-009) have
  to name headers and claims to be testable at all. SC-003 names the Access login because
  it is the regression under test.
- **QA round 1 (senior-developer-qa, 2026-09-23)** returned 2 blocking, 4 major and 8 minor
  findings, all addressed: the connector principal must not inherit COO/manager authority
  (FR-011, FR-012, SC-007); Q2 is reclassified by tool, with code execution by proxy named;
  R2 is now documented rather than unverified; PRM discovery is a blocking unknown with
  fallbacks (FR-009, R5); cut-off is split by auth mode (FR-016); the origin JWT and
  Origin rules are spelled out (FR-006, FR-007).
- **QA round 2** returned 2 blocking and 3 minor findings, all addressed. Class L could
  still start or steer sessions (idle-capacity auto-start, comment steering), which the new
  FR-013a and SC-008 close. `read_knowledge` reaches the credential store and is excluded
  (FR-010). `enable_workflow` / `disable_workflow` are now classified. The claude.ai
  Origin assumption is hedged and live-tested. The SCs are reordered.
- **QA round 3** found a Note-write steering path and an insufficient re-admission rule
  for `read_knowledge`. It asked for a route-by-route audit so Q2's classes would rest on
  evidence rather than tool names. The audit (research.md) covers all 45 R/L tools. It
  added: a class T split out of R for transcripts; `create_experiment` and
  `update_experiment` moved to X (check-in crons); `attach_to_work_item` and
  `create_label` excluded; FR-013a extended to Todo edits, `todo-status` triggers,
  comment attachments and Note writes; and an allow-list, not a deny-list, as the
  re-admission rule for `read_knowledge`.
- **QA round 4: PASS.** Five minor consistency fixes were applied without re-review, as
  QA directed: the FR-013a clause count, US4 deferred under option B, T in option D, the
  "no secret files" wording, and two line refs.
- **Public-repo check (constitution, Hard Constraints).** No hostname, email, tunnel or
  Access id appears in `spec.md` or `research.md`. The instance values are written as
  `<public-host>`, `<team-domain>` and `<app-domain>`.
