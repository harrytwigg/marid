# Research: Remote MCP Connector

**Feature**: [spec.md](./spec.md) · **Todo**: n/a · **Date**: 2026-09-23

This file records what exists today and what was learned about the external systems. It
comes before `plan.md`, which waits for the operator's answers to Q1–Q3 in the spec.

## What already exists (constitution Principle VII)

Verified against `origin/main` @ `11c3fc36`.

| `path:line` | What it is | Use here |
| --- | --- | --- |
| `packages/jinn/src/mcp/server.ts:201` | `handleMcpRequest`: pure JSON-RPC dispatch for `initialize` / `ping` / `tools/list` / `tools/call`, with tool errors returned as results rather than protocol errors | **Reuse as is.** The HTTP transport is a new caller of this function, not a second implementation |
| `packages/jinn/src/mcp/server.ts:117` | `buildTools`: the default 75-tool set (pinned by name at `packages/jinn/src/mcp/__tests__/server.test.ts:90`), plus two attempt-only Workflow tools | The remote profile (FR-010) is a filter over this list, so there is no second copy of any tool |
| `packages/jinn/src/mcp/server.ts:273` | `runJinnMcpServer`: the stdio transport (newline-delimited JSON-RPC) | Stays as is. The HTTP transport sits beside it |
| `packages/jinn/src/mcp/server.ts:96` | `DEFAULT_PROTOCOL_VERSION = "2025-06-18"`, echoing whatever version the client asks for | Streamable HTTP is defined from 2025-03-26 onwards. Claude's connectors build against 2025-11-25, and the current spec revision is 2026-07-28. Echoing an unknown version is a latent bug over HTTP (plan: negotiate against a supported list) |
| `packages/jinn/src/mcp/server.ts:41` | `resolveServerToken`: the stdio server reads the **gateway bearer** from env or `gateway.json` | Must **not** be the remote credential (FR-004) |
| `packages/jinn/src/mcp/identity.ts:73` | `TOOL_CALL_HEADER`: marks a gateway call as coming from an MCP tool | Remote calls carry it, so the gateway never treats them as the operator |
| `packages/jinn/src/gateway/session-comm-guards.ts:333` | `resolveCallerIdentity`: operator / session / unidentified-tool / unauthenticated | Where the connector principal (FR-012) has to fit |
| `packages/jinn/src/gateway/approval-authority.ts:228` | An **operator** caller may decide an `operatorOnly` approval | **Why FR-011 and FR-012 exist.** If the remote endpoint ran on the operator path, a model in a claude.ai chat could clear the gate that exists so no model clears it |
| `packages/jinn/src/gateway/approval-authority.ts:242` | A **session** caller is refused on `operatorOnly`, ahead of every employee path | Covers **operator-only approvals only**. A session caller can still hold COO or manager authority, depending on its shape and rank (next section). This row does not make the principal safe by itself |
| `packages/jinn/src/mcp/delegation-tools.ts:128` and `packages/jinn/src/mcp/session-tools.ts:281` | Delegation and own-children listing refuse a call with no caller session | FR-013: the connector needs a durable session anchor, or these tools must be left out |
| `packages/jinn/src/mcp/identity.ts:156` and `packages/jinn/src/mcp/identity.ts:161` | `ensureSessionCapability` / `verifySessionCapability`: how a session's capability is minted and checked | The anchor for FR-013 is minted and verified here, like any session |
| `packages/jinn/src/mcp/toolkit.ts:111` | `gatewayRequest` always stamps the tool-call marker, plus the caller session when one is set (`:112`) | The in-process hop keeps using the gateway bearer over loopback. FR-004 is about the *client's* credential, not this hop |
| `packages/jinn/src/gateway/auth.ts:250` | `authRequiredForRequest`: public allow-list. Everything under `/api/` and `/ws` needs the gateway token | `/mcp` sits outside `/api/`, so it gets its own auth check and must fail closed on its own |
| `packages/jinn/src/gateway/auth.ts:208` | `hasGatewayBearerAuth`: a constant-time bearer compare | The pattern for option B's connector token, not the token itself |
| `packages/jinn/src/gateway/auth.ts:231` | `isLoopbackHost`: the loopback checks the tunnel defeats | `/mcp` must not depend on any of them |
| `packages/jinn/src/gateway/request-handler.ts:105` | `/api/` dispatch. Everything else falls through to `serveWebUi` | `/mcp` needs its own branch **before** that fallthrough. Today an unknown path gets `200` with the SPA's `index.html` (`packages/jinn/src/gateway/server.ts:200`), which is why US3-1 specifies a `404` JSON |
| `packages/jinn/src/gateway/request-handler.ts:91` | CORS/Origin refusal applies to `/api/` only | MCP streamable HTTP requires `Origin` validation (DNS-rebinding guard). `/mcp` needs it explicitly |
| `packages/jinn/src/mcp/__tests__/tool-manifest-budget.test.ts:10` | `MAX_MANIFEST_TOKENS = 6133` for the **session** manifest | Unaffected: no tool is added. A remote-profile budget is not needed (claude.ai loads tools on demand) |

### Authority the principal must not inherit (FR-011, FR-012)

The obvious durable anchor for a connector is a parentless session with no employee and no
workflow. That is exactly the shape the gateway treats as its own COO portal:

| `path:line` | What that shape is granted |
| --- | --- |
| `packages/jinn/src/sessions/registry.ts:1254` | `isPortalAgentSession` = `!employee && !parentSessionId && !workflowProvenance` |
| `packages/jinn/src/gateway/approval-authority.ts:252` | COO-decidable Todo approvals, decided as `kind: "operator"` |
| `packages/jinn/src/gateway/approval-authority.ts:274` | Otherwise rank decides: a `manager` or `executive` employee gets routed approval powers |
| `packages/jinn/src/gateway/workflow-decider-authority.ts:25` | COO-reserved Workflow gates |
| `packages/jinn/src/gateway/work-item-authority.ts:47` | Owner authority over every Todo |
| `packages/jinn/src/gateway/work-item-arming.ts:66` | Acting as the operator when arming |
| `packages/jinn/src/gateway/api.ts:990` | States it directly: the parentless shape "carries operator-delegated authority" |

So the connector principal can be neither portal-shaped nor a manager or executive
employee. The plan has to choose a shape that satisfies the session guards (FR-013) and
fails every one of the checks above. SC-007 tests that it does.

### Ledger writes that start or steer sessions (FR-013a)

| `path:line` | What it does |
| --- | --- |
| `packages/jinn/src/work-items/store.ts:425` | A new Todo defaults to `backlog` |
| `packages/jinn/src/gateway/idle-capacity-backlog.ts:35` | `skipReason`: idle-capacity auto-start passes over a backlog Todo only for the `no-auto-start` label, `autoStart:false`, a non-Claude engine override, or a pending approval. Anything else is eligible |
| `packages/jinn/src/gateway/idle-capacity-backlog.ts:65` | Eligible Todos are started highest priority first, so a created Todo can jump the queue |
| `packages/jinn/src/shared/idle-capacity-config.ts:59` | `IDLE_CAPACITY_OPT_OUT_LABEL = "no-auto-start"` |
| `packages/jinn/src/mcp/label-tools.ts:25` | `label_work_item` has a `remove` mode, which could strip the opt-out label |
| `packages/jinn/src/gateway/todo-comment-steering.ts:120` | `forwardToDelegatedSession`: a Todo comment is forwarded as a prompt into the newest live session delegated to that Todo |
| `packages/jinn/src/gateway/todo-comment-steering.ts:129` | The only author it skips is the target itself (and system authors at `:128`). A connector author would steer |

So a connector that can only "write to the ledger" can still start code (create a backlog
Todo) and prompt a running shell session (comment). FR-013a closes both for the connector
principal, or class L leaves the profile.

### Secrets reachable by read tools (FR-010)

| `path:line` | What it is |
| --- | --- |
| `packages/jinn/src/notes/store.ts:729` | `readKnowledgeFile`: enforces a normalised relative path inside the instance home, and **nothing else**. There is no secrets deny-list, so the credential store under the instance's secrets directory and the gateway config file that holds the bearer are both readable. QA reproduced this against a temp home |
| `packages/jinn/src/gateway/api.ts:1818` | `/api/knowledge/read` calls it directly. This is the route behind `read_knowledge` |
| `packages/jinn/src/gateway/files.ts:453` | `assessFileRead`'s deny-list refuses the secrets directory, `.env*` and key/token files, but **not** the gateway config file holding the bearer, nor `config.yaml`. So parity with it would not be enough to re-admit `read_knowledge` (FR-010 now requires an allow-list) |
| `packages/jinn/src/gateway/files.ts:536` | `read_file` is safe for another reason: `readManagedFile` resolves only under the managed `files/` and `uploads/` roots (`packages/jinn/src/shared/paths.ts:103`, `:108`). The capability-bound refusal at `files.ts:109` guards delete and path-attachment only (`:1130`, `:1364`), not reads. An earlier round said otherwise |
| `packages/jinn/src/mcp/identity.ts:156` | The secrets directory also holds the key every session capability is derived from, so `read_knowledge` as it stands lets a caller **forge any session's identity**, including the portal's |
| `packages/jinn/src/notes/store.ts:613` | `search_knowledge` covers only `knowledge/` and `docs/` |

This is pre-existing and harmless for local engine sessions, which already have shell. It
becomes an exposure only with a remote door, which is why FR-010 excludes `read_knowledge`
until it has a deny-list.

### Route audit of every R and L tool (QA round 3)

Each tool was traced from its MCP definition, through the gateway route and handler, to the
authority applied to a **capability-bound session that is neither the operator, nor
portal-shaped, nor ranked**, which is the connector principal FR-012 requires. The trace
also records every side effect. Four read-only audits ran in parallel, and every
non-SAFE row, plus `read_file`, was then re-read by hand. Handler lines are at `11c3fc36`.

**Common fact**: reads are gated only by "is this a bound session?"
(`packages/jinn/src/gateway/api.ts:887`), never by rank or ownership. Every R tool
therefore reads **company-wide**, with the same reach the dashboard has.
`list_heartbeats` is the one exception: it is scoped to the caller.

| Tool | Route · handler | Authority for the connector | Side effects | Verdict |
| --- | --- | --- | --- | --- |
| `list_work_items`, `get_work_item`, `search_work_items`, `get_work_item_tree`, `list_work_item_comments`, `list_work_item_attachments`, `list_departments`, `list_labels` | GET `/api/work-items*` `api.ts:2258`, `:2427`, `:2870`, `:2879`, `:3093`; `search-api.ts:151`; `api.ts:3322`, `:3315` | bound session | none. Attachments return metadata and path only | SAFE |
| `list_sessions` | GET `/api/sessions` `api.ts:1854`; `…/children` `:2224` | bound session, company-wide | none | SAFE (metadata) |
| `read_session` | GET `/api/sessions/:id` `api.ts:1898` | bound session, **any** session | may schedule a transcript backfill or tail sync (`api.ts:1918`, `:1924`). The tail sync can deliver a *real*, already-pending external reply to that session's parent (`packages/jinn/src/gateway/external-turns.ts:435`). The caller does not choose the content | **T**: raw transcript of any session, tool output included |
| `get_message_context` | GET `/api/sessions/:id/context` `api.ts:2236` | bound session, any session | none | **T**: raw messages, any role |
| `search_messages` | GET `/api/search/messages` `search-api.ts:73` | bound session, company-wide | none | **T**: ≤300-char snippets of any message |
| `search_sessions` | GET `/api/search/sessions` `search-api.ts:134` | bound session | none | SAFE (summaries) |
| `list_employees`, `find_employees` | GET `/api/org` `org-api.ts:24` | bound session | none | SAFE. Persona is stripped (`org-api.ts:10`) |
| `get_employee` | GET `/api/org/employees/:name` `org-api.ts:47` | bound session | none | SAFE with a caveat: full persona text and remote-host fields, no credentials |
| `list_notes`, `read_note` | GET `/api/notes*` `api.ts:1721`, `:1729` | bound session | none. Confined to `knowledge/` | SAFE |
| `search_knowledge` | GET `/api/knowledge/search` `api.ts:1792` | bound session | none. `knowledge/` and `docs/` snippets only | SAFE |
| `list_files`, `read_file` | GET `/api/files*` `files.ts:1273`, `:1225` | bound session | none. Confined to `files/` and `uploads/` (`files.ts:536`) | SAFE. Uploads hold whatever was uploaded |
| `list_experiments`, `get_experiment` | GET `/api/experiments*` `packages/jinn/src/gateway/experiments-api.ts:183` | bound session | none | SAFE |
| `list_workflows`, `get_workflow`, `list_workflow_runs`, `get_workflow_run` | GET `/api/workflows*` `packages/jinn/src/gateway/workflow-api.ts:133`, `:139`, `:161`, `:171` | bound session | none. `view=full` adds prompt text and node outputs | SAFE. No secret fields in the schema |
| `list_cron_jobs`, `get_cron_run_history` | GET `/api/cron*` `packages/jinn/src/gateway/cron-api.ts:153`, `:157` | bound session | none. Prompts are excluded server-side | SAFE |
| `cost_report` | GET `/api/cost/report` `api.ts:1697` | bound session | none. SQL aggregate, no CLI spawn | SAFE |
| `list_heartbeats` | GET `/api/heartbeats` `packages/jinn/src/gateway/heartbeat-api.ts:74` | the caller's own only | none | SAFE |
| `read_knowledge` | GET `/api/knowledge/read` `api.ts:1805` | bound session | reads any file in the instance home | **SECRETS**: excluded (FR-010) |
| `create_work_item` | POST `/api/work-items` `api.ts:2287` | bound session | creates a `backlog` Todo. Idle-capacity starts it unless opted out (`idle-capacity-backlog.ts:35`), and `todo-status` triggers see it (`api.ts:2334`) | **STARTS** unless FR-013a(i) |
| `edit_work_item` | PATCH `/api/work-items/:id` `api.ts:2441` | content fields (title, body, acceptance, priority, due) open to **any** session on **any** Todo (`packages/jinn/src/gateway/todo-edit-authority.ts:16`) | rewrites the text a later session is started with | **STEERS** unless FR-013a(ii) |
| `comment_work_item` | POST `/api/work-items/:id/comments` `api.ts:2902` | bound session, any Todo | forwarded as a prompt to the live session (`api.ts:2940` → `todo-comment-steering.ts:120`). Its `attachments` argument reads host files like `attach_to_work_item` | **STEERS** and **HOST-FILE** unless FR-013a(iii) |
| `label_work_item` | PUT `/api/work-items/:id/labels` `api.ts:3285` | creator, assignee or operator only (`api.ts:3293`) | a label change re-drains pending `todo-status` triggers (`packages/jinn/src/gateway/server.ts:939`) | SAFE on the connector's own Todos under FR-013a(i)–(ii) |
| `create_label` | POST `/api/labels` `api.ts:3328` | operator or manager only | none reached | refused for the connector, so it leaves the profile |
| `link_work_items`, `unlink_work_items` | POST/DELETE `…/relations` `api.ts:3159`, `:3193` | bound session; unlink is creator-only, enforced in `removeRelation` via its actor/operator arguments (`api.ts:3214`) | a DAG edge only. No unblock or auto-start coupling | SAFE |
| `attach_to_work_item` | POST `…/attachments` (JSON path branch) `api.ts:3053` | bound session, any Todo | reads **any host path** passing `assessFileRead`, including the bearer file and `config.yaml`, and copies it into attachment storage. The managed-files equivalent is operator-only (`files.ts:1130`) | **HOST-FILE**: excluded |
| `create_note` | POST `/api/notes` `api.ts:1740` | no caller check | creates a new `.md` anywhere under `knowledge/`, including per-employee files | **INSTRUCTION-WRITE** unless FR-013a(iv) |
| `update_note` | PUT `/api/notes` `api.ts:1759` | **no caller check at all** | rewrites any Note, including the always-in-context state file and per-employee files agents load as instructions | **INSTRUCTION-WRITE** unless FR-013a(iv) |
| `create_experiment` | POST `/api/experiments` `experiments-api.ts:205` | bound session. Cron creation is operator-only (`api.ts:938`), this is not | a `checkIn` writes a **cron job** whose prompt embeds caller text (`packages/jinn/src/experiments/check-in.ts:35`, `:85`) and later runs as the named employee | **STARTS**: moved to X |
| `update_experiment` | PATCH `/api/experiments/:id` `experiments-api.ts:210` | bound session | rewrites an existing check-in cron's prompt (`check-in.ts:146`) | **STEERS**: moved to X |
| `record_reading`, `conclude_experiment` | POST `…/readings`, `…/conclude` `experiments-api.ts:153`, `:169` | bound session | a UI event only. Conclude *disarms* the check-in | SAFE |

**Untraced, and config-dependent rather than code-provable**: which `todo-status` Workflows
on a given instance would match a connector-created Todo. FR-013a(i) removes the question
by suppressing them for connector Todos.

**Considered and rejected**

- *Put the connector on `/api/mcp`.* That would inherit the gateway-token middleware at
  `auth.ts:250`, which is the wrong credential (FR-004) and the wrong principal (operator).
- *Spawn `runJinnMcpServer` per HTTP session and pipe to it.* That means a process per
  chat, identity forced through env, and a second JSON-RPC framing. `handleMcpRequest` is
  already transport-free.
- *`@modelcontextprotocol/sdk` for the HTTP transport.* `server.ts` records why the repo
  hand-rolls the protocol (pnpm 7-day age gate, dependency surface). Streamable HTTP with
  JSON-only responses adds little to that: POST + `Accept` negotiation, an optional
  `Mcp-Session-Id`, and 405 on GET. The plan should say whether that still holds once
  auth metadata is added. Under option A, Access serves the OAuth metadata, so the origin
  adds almost nothing.

## External findings

### R1: Cloudflare Access can be the OAuth server for MCP clients (supports Q1 option A)

- **Managed OAuth** is a per-application toggle: Zero Trust → Access → Applications →
  *app* → Advanced settings → Managed OAuth. It supports self-hosted applications and MCP
  server applications. [Managed OAuth docs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- Access serves the discovery document at `https://<app-domain>/.well-known/oauth-authorization-server`.
  Non-browser clients get a `401` with a `WWW-Authenticate` header that points at the
  metadata, instead of the `302` browsers get. So browsers on the existing application
  keep their current login. (Quoted from the docs.)
- Dynamic client registration is allowed against an **allowed redirect URIs** list, and
  "the URL must use `https`". Allow-list the exact URIs
  `https://claude.ai/api/mcp/auth_callback`
  ([Claude connector authentication](https://claude.com/docs/connectors/building/authentication))
  and `https://claude.com/api/mcp/auth_callback`, since Anthropic has said the callback may
  move there ([Anthropic support](https://support.anthropic.com/en/articles/11503834)).
- The origin receives `Cf-Access-Jwt-Assertion`. To validate it: JWKS from
  `https://<team-domain>/cdn-cgi/access/certs`, check the signature, `aud` equal to the
  application's AUD tag, `iss`, and `exp`.
  [Validate JWTs](https://developers.cloudflare.com/access/setting-up-access/validate-jwt-tokens)
- **Plan tier**: the docs do not say. Unverified.
- **Token lifetime**: "Access token lifetime" is configurable. The docs recommend 5–15
  minutes, with a longer grant session so the client refreshes in the background and
  policies are re-evaluated on each refresh. No revocation mechanism is documented, which is
  why FR-016 cuts off at the origin.

### R2: Claude Code and Managed OAuth (documented, to be confirmed live)

Claude Code runs OAuth with an RFC 8252 loopback redirect (`http://localhost/callback`,
`http://127.0.0.1/callback`, any port). The https-only rule applies to the allowed-URIs list
only. Managed OAuth has separate toggles for this case: **"Allow localhost clients"**
(`allow_any_on_localhost`) and **"Allow loopback clients"** (`allow_any_on_loopback`),
both on the same [Managed OAuth page](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).
CIMD support does not matter: Claude falls back to DCR when the authorization server does
not advertise `client_id_metadata_document_supported`
([Claude connector authentication](https://claude.com/docs/connectors/building/authentication),
"DCR and CIMD details").

**Caveat**: with either toggle on, *any* local process on *any* machine can register a
client. The Access login (the allow policy) is what still stops it. The plan confirms the
flow live from Claude Code. If it fails, fall back to an Access service token (R3).

### R3: Path-scoped Access applications

Several Access applications can share a hostname, scoped by path. The more specific path
wins and does **not** inherit the parent's policy.
[App paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths).
Two layouts to try in the plan:

1. **Enable Managed OAuth on the existing application.** One app, and browsers are
   unaffected (they still get `302`). This is the simplest option, and the well-known
   metadata path is covered automatically. An OAuth token then admits a client to every
   path at the edge, but the origin still requires the gateway token for `/api/*` and
   `/ws`, so the token alone opens only `/mcp`.
2. **A second application scoped to `/mcp`** with Managed OAuth. It is tighter at the edge,
   but it is unverified whether Access serves `/.well-known/oauth-*` for a path-scoped app,
   since those paths fall under the `/` application. Try layout 1 first.

For an extra Claude Code credential (if R2 fails), a **service token** with a `Service Auth`
policy on the same application keeps Access in front, and Claude Code can send the
`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers. This is preferred over a bypass
policy plus a Jinn-only bearer.

### R4: Claude connector facts

- Auth types: `oauth_dcr` and `oauth_cimd` work out of the box. `custom_connection`
  (manual client id and secret) needs Anthropic review. `static_headers` is beta. `none`
  means no auth. PKCE S256 is always sent.
  [Claude connector authentication](https://claude.com/docs/connectors/building/authentication)
- claude.ai connector traffic comes from Anthropic's servers, whose outbound range is IPv4
  `160.79.104.0/21` only. (`2607:6bc0::/48` on the same page is an *inbound* range. Do
  not use it in rules.) [IP addresses](https://platform.claude.com/docs/en/api/ip-addresses).
  A WAF skip rule scoped to `/mcp` can key on that range, and so can an optional
  defence-in-depth IP check (the range does not cover Claude Code, which runs on the
  operator's machine).
- Transport: streamable HTTP. HTTP+SSE is deprecated in the MCP spec.

### R5: MCP spec obligations, and protected-resource discovery (blocking unknown)

From the [2025-06-18 transports spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
and [authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization):

- One endpoint for POST (and optionally GET). `Mcp-Session-Id` is optional.
- The server **MUST** validate `Origin` against DNS rebinding (FR-007).
- The resource server **MUST** publish RFC 9728 protected-resource metadata (PRM) and
  **MUST** validate token audience.

**Discovery is the likeliest point of failure for claude.ai.** Claude expects a `401`
whose `WWW-Authenticate` carries `resource_metadata=` pointing at the PRM document. Without
it, Claude probes `/.well-known/oauth-protected-resource/mcp` and then
`/.well-known/oauth-protected-resource`. The PRM `resource` must equal the connector URL
exactly, `/mcp` included ([Claude connector authentication](https://claude.com/docs/connectors/building/authentication)).
The Managed OAuth page says only that the 401 "points the client to Access's OAuth
discovery metadata", and that the authorization-server endpoint "conforms to RFC 8414 and
RFC 9728". It does not say that Access serves a PRM document, or what `resource` it would
contain.

**Test, before anything else is built**: from outside, `curl -i -X POST
https://<public-host>/mcp` with no credentials. Record the status, the full
`WWW-Authenticate`, and what each of the two probe paths above returns. On the first real
claude.ai request that reaches the origin, record whether it sends an `Origin` header and
its value (FR-007).

**Fallbacks**, if Access does not serve a PRM whose `resource` is the `/mcp` URL. Note that
under layout 1 the origin *cannot* just serve a static PRM, because `/.well-known/*` is
behind the same Access application and gets a 401/302 before the origin sees it.

1. An Access **bypass** application scoped to exactly the two PRM paths, with the origin
   serving a static document (its `resource` is the `/mcp` URL, and its
   `authorization_servers` is Access). This exposes nothing: the document is public by
   design.
2. Layout 2 (a path-scoped app on `/mcp`) combined with fallback 1.

### R6: Cloudflare edge pitfalls

- **Bot Fight Mode**: "You cannot bypass or skip Bot Fight Mode using WAF custom rules or
  Page Rules", but it "will not trigger if an IP Access rule matches the request first"
  ([Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)).
  So the narrow fix is an IP Access **allow** rule for `160.79.104.0/21`, not turning BFM off
  for the zone. That covers claude.ai only. Claude Code calls from the operator's own
  network and needs BFM not to flag it, so confirm that live.
- **Super Bot Fight Mode** is a paid-plan feature that supports skip rules. It does not
  apply on the free plan.
- The proxy has a ~100 s origin timeout. With JSON-only responses there is no long-lived
  stream to buffer, so the SSE buffering reports
  ([cloudflared#1095](https://github.com/cloudflare/cloudflared/issues/1095)) do not
  apply. A tool that can block past ~90 s must return early.
- The live ingress already sends every non-`/api/internal/` path to the origin, so
  `/mcp` and the PRM paths need **no ingress change** (FR-017). The edge changes are all in Access and zone
  security.

### R7: Anthropic MCP tunnels (not used)

This is a research preview for the API and agent platform, gated behind an access
request, and it does not serve claude.ai custom connectors. Out of scope (spec,
Assumptions).
