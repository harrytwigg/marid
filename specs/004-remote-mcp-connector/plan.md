# Implementation Plan: Remote MCP Connector

**Branch**: `feat/remote-mcp-spec` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md)

**Input**: spec.md, with the operator's answers of 2026-09-23. Q1 is **A** (Cloudflare Access
Managed OAuth). Q2 is **B** (classes R + L, hardened by FR-013a, with no T and no X). Q3 is
the default: a distinct principal.

## Summary

The gateway gains a `/mcp` endpoint, served in-process, speaking MCP streamable HTTP with
JSON-only responses. Each request is authenticated by verifying the
`Cf-Access-Jwt-Assertion` that Cloudflare Access (Managed OAuth) attaches. The verified
identity maps to a **connector anchor session**. Tool calls reuse `handleMcpRequest` and the
existing tool handlers. They reach the gateway's own routes over loopback as that anchor
session, so every existing session guard applies. The anchor also has to clear three new,
gateway-side rules:

1. it is never portal-shaped;
2. it never runs an engine;
3. a route allow-list at the API's identity gate admits only the routes its tool profile
   uses.

The FR-013a rules sit at the four write routes that remain.

## Existing infrastructure (constitution VII)

research.md carries the full table and the route audit. The rows this plan builds on,
at the branch head (the lines this change added or moved are cited where they now sit):

| `path:line` | Used for |
| --- | --- |
| `packages/jinn/src/mcp/server.ts:201` | `handleMcpRequest`: reused unchanged as the JSON-RPC core |
| `packages/jinn/src/mcp/server.ts:117` | `buildTools`: the remote profile filters it |
| `packages/jinn/src/gateway/request-handler.ts:90` | The HTTP handler. `/mcp` and the protected-resource paths branch off before CORS and the SPA fallback |
| `packages/jinn/src/gateway/api.ts:1261` | The identified-caller gate every tool call passes, *before* the Workflow API. The connector route allow-list goes here |
| `packages/jinn/src/sessions/registry.ts:1254` | `isPortalAgentSession`: gains "and not a connector session" |
| `packages/jinn/src/sessions/turn/preflight.ts:48` | `refuseTurn`: the single gate before any engine spawn. It refuses connector sessions |
| `packages/jinn/src/gateway/api.ts:2542` | The PATCH route's edit authority. A connector may edit only Todos it created (checked just before it) |
| `packages/jinn/src/gateway/api.ts:2313` | Create-time `autoStart:false` opt-out. Forced for connector Todos, plus the label |
| `packages/jinn/src/gateway/todo-comment-steering.ts:130` | The steering author skip. Connector authors are skipped too |
| `packages/jinn/src/work-items/workflow-event-feed.ts:293` | Trigger feed reads only `status_change`/`escalated` events. The connector has no status route in its allow-list, so it cannot produce one (FR-013a(1) holds by construction and is tested) |
| `packages/jinn/src/mcp/identity.ts:156` | `ensureSessionCapability`: mints the anchor's capability in-process. It never leaves the gateway |

## Technical Context

**Language/Version**: TypeScript on Node ≥ 22 (repo `.nvmrc`)

**Primary Dependencies**: none new. JWT verification uses `node:crypto` (JWK import and
RSA-SHA256 verify). The JWKS is fetched with global `fetch`.

**Storage**: a connector anchor is an ordinary `sessions` row with `source = "remote-mcp"`.
No schema change.

**Testing**: vitest. JWT tests use a locally generated RSA key and an injected JWKS fetcher
and clock. Route-rule tests drive the real `handleApiRequest` as a connector session.

**Constraints**:
- Size ratchet: `gateway/api.ts` and `sessions/registry.ts` are already over budget on
  `main`, and `mcp/server.ts` is exactly at budget. Neither may grow. New code lives in new
  files of ≤ 300 lines. `api.ts` shrinks by moving `operatorOnlyControlPlaneRoute` out,
  which pays for its three hooks.
- No new dependency (pnpm age gate; `server.ts:84`).

**Scale/Scope**: one operator and one identity, at a few requests per minute.

## Design decisions

- **D1: the anchor session.** One per verified email, found or created on the first call:
  - `source: "remote-mcp"`, `sourceRef: "remote-mcp:<email>"`, no employee, no parent;
  - title "Remote MCP connector (<email>)";
  - engine set to the config default, but it is never run (D3).

  It shows in the dashboard's direct group, which is FR-012's attribution. Its writes carry
  `createdBy: session:<anchor-id>`.
- **D2: not the portal.** `isPortalAgentSession` returns false for `source === "remote-mcp"`.
  That removes the COO lane at all four call sites at once: approvals, Workflow deciders,
  work-item authority and arming (SC-007). Without an employee the anchor also fails every
  rank check, so it holds no approval authority (FR-011).
- **D3: never runs.** `refuseTurn` refuses a connector session. A callback, comment or
  message routed to it settles as an error instead of spawning an employee-less engine,
  which would be COO-shaped.
- **D4: route allow-list.** At `api.ts:1261`, a connector caller may reach only the
  (method, route) pairs its tool profile uses. Everything else gets `403`, before any
  handler runs, including the Workflow API. It is the same list the profile's tools call,
  and a test drives every profile tool against a recording fetch to prove it.
- **D5: FR-013a at the write routes.**
  - (1) Create forces `autoStart:false` and the `no-auto-start` label.
  - (2) Edits are limited to the connector's own Todos (at the PATCH route), and a
    label change may not remove `no-auto-start`.
  - (3) Steering skips connector authors. Comment attachments use the attachments route,
    which is not on the allow-list.
  - (4) Note writes are confined to `knowledge/remote-mcp/`.
  - (5) Experiments are not in the profile.
- **D6: transport.**
  - `POST /mcp` takes one JSON-RPC message, with a 1 MiB cap. A request gets `200
    application/json`, and a notification or response gets `202`. A batch array gets `400`.
  - `GET` and `DELETE` get `405`. The endpoint is stateless, with no `Mcp-Session-Id`.
  - Protocol version: the client's requested version is echoed if it is in
    {2025-11-25, 2025-06-18, 2025-03-26}. Otherwise the server answers 2025-11-25.
- **D7: auth order.** The checks run in this order:
  1. disabled → `404` JSON;
  2. `Origin` not allow-listed → `403 origin-refused`;
  3. POST without `application/json` → `415`;
  4. config incomplete → `503 misconfigured`;
  5. no assertion → `401` with `WWW-Authenticate: Bearer resource_metadata=…`;
  6. assertion invalid → `401`;
  7. email on the deny-list → `403 cut-off`;
  8. email not on the allow-list → `403`.

  JWT checks: RS256 only, `kid` looked up in a JWKS cached for 10 minutes (one refetch on an
  unknown `kid`, at most once a minute), `iss` equal to `https://<teamDomain>`, `aud`
  containing the configured AUD, and `exp`/`nbf` within 60 s of leeway.
- **D8: protected-resource metadata.** When enabled, the origin serves RFC 9728 at
  `/.well-known/oauth-protected-resource` and `…/mcp`, with `resource = <resourceUrl>` and
  `authorization_servers = [origin of resourceUrl]`. Whether Access lets those paths
  through is the live test in R5.
- **D9: observability.** Every request logs one `[remote-mcp]` line with outcome, reason,
  email, method, tool and duration, and never the token. `GET /api/remote-mcp`, behind
  the gateway-token gate, returns `{enabled, lastRequestAt, lastOutcome, lastRefusal}` from
  memory (FR-015).
- **D10: config.** Keys under `gateway.remoteMcp`:
  - `enabled`, `resourceUrl`;
  - `access: { teamDomain, aud }`;
  - `allowedEmails[]`, `deniedEmails[]`, `allowedOrigins[]`.

  Validated in `shared/config.ts` and read live per request, so a change needs no restart.

## Constitution Check

- **I (fork):** fork-local, with no upstream considerations. Pass.
- **II (direction):** rung 4, stated in spec.md. No new autonomy, so no spend ceiling is
  needed.
- **III (verify premise):** every security premise was reproduced in the route audit
  (research.md) against the tree.
- **IV (Footprint Ladder):** the session manifest is unchanged, and no core tool is added.
  The remote profile is a *subset* served on a new transport. Pass.
- **V (no speculation):** every config key has its consumer in this change. There is no
  abstraction for "other auth modes": B is not built.
- **VI (tests):** JWT branches, route allow-list, FR-013a rules, the portal predicate and
  `refuseTurn` all get tests that fail for a reason. There are no snapshot tests.
- **VII (file:line table):** above, and in research.md.
- **VIII (comments):** each hook comments *why* and cites FR ids.
- **Hard constraints:** no instance data in the tree. The runbook uses placeholders.

## Complexity Tracking

| Choice | Why not simpler |
| --- | --- |
| Hand-rolled JWT verify (~80 lines) | A JWT library is a new dependency (age gate, surface). RS256 over JWK in `node:crypto` is small and fully testable |
| A route allow-list *and* a tool filter | The tool filter alone means one mistake exposes a route. The gateway rule makes the profile hold even if the anchor's capability leaked |
