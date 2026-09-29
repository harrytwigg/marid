# Tasks: Remote MCP Connector

**Input**: [plan.md](./plan.md) · **Todo**: 

The size ratchet applies to every task: new files are ≤ 300 lines, `gateway/api.ts`,
`sessions/registry.ts` and `mcp/server.ts` do not grow, and nothing is added to a baseline
by hand.

## Phase 1: Foundation

- [x] T001 Add the `gateway.remoteMcp` config type and validation, with tests
  (`shared/remote-mcp-config.ts`, hooked into `shared/config.ts` and `shared/config-types.ts`)
- [x] T002 Add `REMOTE_MCP_SESSION_SOURCE` and `isRemoteMcpSession`
  (`sessions/remote-mcp-session.ts`)
- [x] T003 Make `isPortalAgentSession` false for connector sessions (D2), with a test
- [x] T004 Make `refuseTurn` refuse connector sessions (D3), with a test

## Phase 2: Gateway rules (FR-011, FR-013a, D4, D5)

- [x] T005 Move `operatorOnlyControlPlaneRoute` out of `api.ts` into
  `gateway/control-plane-routes.ts` (pays for T006–T008), as a table so it meets the
  complexity limit outside `api.ts`'s grandfathered exemption
- [x] T006 Add the connector route allow-list (`gateway/remote-mcp/rules.ts`) and hook it
  at the identified-caller gate
- [x] T007 Make create force `autoStart:false` and `no-auto-start` for connector callers,
  and make the label route refuse removing `no-auto-start`
- [x] T008 Confine note writes to `knowledge/remote-mcp/` for connector callers
- [x] T009 Limit edits to the connector's own Todos (enforced at the PATCH route: `todo-edit-authority.ts` was already at its complexity limit)
- [x] T010 Skip comment steering for connector authors
- [x] T011 Route tests as a connector session: SC-007 (COO-decidable, operator-only
  approvals, a Workflow gate, someone else's Todo) and SC-008 (create is non-startable, no
  label removal, no foreign edit, no steering, note confinement), plus an off-list route
  getting `403`

## Phase 3: Transport and auth (US1, US2)

- [x] T012 Access JWT verifier with an injected JWKS fetch and clock, with tests
  (`gateway/remote-mcp/access-jwt.ts`)
- [x] T013 Tool profile and the anchor-session resolver (`gateway/remote-mcp/profile.ts`,
  `gateway/remote-mcp/principal.ts`)
- [x] T014 `/mcp` HTTP handler, protected-resource metadata and status state
  (`gateway/remote-mcp/http.ts`), wired in `request-handler.ts`, with tests covering the
  D7 order, 405, 202, batch and the version echo
- [x] T015 Profile test: every profile tool, driven against a recording fetch, calls only
  allow-listed routes, and no excluded tool is present
- [x] T016 `GET /api/remote-mcp` status, served to any gateway-token holder (the dashboard and agent sessions alike). The content is harmless: no credential, no identity

## Phase 4: Ship

- [x] T017 Runbook `docs/remote-mcp.md`: Access Managed OAuth settings, redirect URIs,
  localhost/loopback toggles, token lifetime, the IP Access rule for `160.79.104.0/21`,
  config keys, and the Claude Code and claude.ai steps
- [ ] T018 Run `pnpm typecheck`, `lint`, `test`, `build` and `ratchet --check`
  (no new violations)
- [ ] T019 Draft PR, merge, then deploy via `skills/upgrade-jinn`
- [ ] T020 Configure the instance and verify live: disabled 404, then enabled, the curl
  test from R5, Claude Code
- [ ] T021 senior-developer-qa review, after deploy, at the operator's request

## Deferred

- A CLI wrapper for the status route (FR-015 is met by the operator API).
- Class T and class X (v2, per Q2).
- Fixing `read_knowledge` with an allow-list, the notes caller check and Todo content
  authority for *all* sessions. These are pre-existing and get separate Todos.
