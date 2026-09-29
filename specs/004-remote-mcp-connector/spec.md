# Feature Specification: Remote MCP Connector

**Feature Branch**: `feat/remote-mcp-spec`

**Created**: 2026-09-23

**Status**: Answered by the operator 2026-09-23 (Q1: A, Q2: B, Q3: default). Implemented; see plan.md and tasks.md

**Amended 2026-09-23**: the operator decided the connector is his own
privileged convenience door, guarded by the bridge (FR-003 to FR-007, FR-016), not by a
narrower ledger standing. FR-013a is withdrawn: connector Todos are ordinary Todos,
its edits, labels, links and Note writes reach anything the operator's would, and its
comments steer like the operator's. The profile gains session control: `read_session`,
`send_to_session`, `delegate_task` (US4) and `assign_work_item`, and the anchor has the
operator's standing to assign, re-delegate, label and unlink any Todo. Its Todo edits are
the content fields any session may edit; ownership fields change through assignment. It is still not portal-shaped and holds no approval
authority (FR-011, FR-012 unchanged). Where the text below says otherwise, this wins.

**Input**: The originating Todo. The operator wants to use Jinn from inside ordinary Claude
chat: claude.ai on the web first, then Claude Desktop/Cowork and Claude Code. That means
adding Jinn as a **custom connector**, which needs a remote MCP server reachable at one
public HTTPS URL. The operator already runs a Cloudflare Tunnel with Cloudflare Access in
front of the gateway's hostname (Todo, live since 2026-09-22) and wants that tunnel
reused rather than a second one stood up. The operator's brief proposed a static
header/API key first and OAuth later, and asked for the Cloudflare pitfalls to be
covered: bot challenges, and Access blocking server-to-server calls.

> Deployment specifics (hostname, tunnel id, Access application id, identity-provider
> email) are instance data. They live in the instance note on the tunnel, not in this public
> repository (constitution, Hard Constraints). This spec writes them as `<public-host>`.

## Why This Matters *(constitution Principle II)*

This feature sits on rung **4** of Principle II's ranking, and it stays there on purpose. It
moves no decision to the system. What it changes is where the operator can reach the system
from. Today the only surfaces are the dashboard and a Telegram connector. With this feature
any Claude chat becomes a place where the operator can check the Todo ledger, read a
session, or start a delegation. The feature is also constrained by what Principle II says
about legibility: every call made through the new door has to be attributable, and anything
done through it must be auditable afterwards.

It adds **no** core tools and does not change the tool manifest that engine sessions get
(Principle IV). The tools already exist. This feature exposes a subset of them over a
second transport.

## User Scenarios & Testing *(mandatory)*

### User Story 1: The operator uses Jinn from Claude Code over the network (Priority: P1)

The operator is on a machine that is neither the gateway host nor on the LAN. They run
`claude mcp add --transport http jinn https://<public-host>/mcp` with whatever credentials
the chosen auth mode requires (Q1). They ask Claude Code "what's in executing on the Todo
board?" and get the real list back from the live instance.

**Why this priority**: it is the cheapest end-to-end proof. Claude Code supports custom
headers and OAuth natively, so it separates "is the server correct?" from "does claude.ai's
connector UI accept it?". It is also the operator's stated first test.

**Independent Test**: from a machine outside the LAN and the tailnet, `claude mcp list`
shows `jinn` as connected. A prompt that calls `list_work_items` returns rows that match the
dashboard.

**Acceptance Scenarios**:

1. **Given** valid credentials, **When** the client initialises, **Then** the server
   answers with its name, version, a protocol version the client accepts, and the tool list
   for the remote profile (FR-010). The whole handshake takes under 2 seconds on a warm
   gateway.
2. **Given** no credentials or wrong ones, **When** the client connects, **Then** the call
   is refused before it reaches any tool. The refusal is logged with a reason code (FR-014),
   and the response discloses nothing about which tools exist.
3. **Given** a working connection, **When** a tool fails (for example an unknown Todo
   id), **Then** the client gets a tool-level error it can read and recover from. The
   connection stays up.

---

### User Story 2: The operator uses Jinn from claude.ai on the web (Priority: P1)

In claude.ai the operator opens Settings → Connectors → Add custom connector, pastes
`https://<public-host>/mcp`, and completes whatever sign-in the chosen auth mode requires.
A normal chat can then read and act on the company.

**Why this priority**: this is the outcome the operator asked for. It is P1 alongside
Story 1 but is built second, because claude.ai's connector UI is the most restrictive
client. It calls from Anthropic's servers rather than the operator's browser, it cannot
solve a challenge page, and its custom-header support is a beta feature.

**Independent Test**: in a fresh claude.ai chat with the connector enabled, "list my Todos
in in_review" returns the real list. The call appears in the gateway's remote-MCP log,
attributed to the connector principal (FR-012).

**Acceptance Scenarios**:

1. **Given** the connector is added, **When** the operator completes the sign-in once,
   **Then** later chats use the connector without prompting until the credential expires or
   is revoked (FR-016).
2. **Given** Cloudflare's bot or security features are on for the zone, **When** Anthropic's
   servers call `/mcp`, **Then** the request reaches the origin and gets no challenge page.
   Otherwise the deployment runbook names the exact setting that has to change.
3. **Given** the Cloudflare Access application that already protects the dashboard, **When**
   the connector is added, **Then** the dashboard's protection is unchanged. A browser
   hitting `/` still gets the Access login (no regression check V1).

---

### User Story 3: The operator can see and cut off the remote door (Priority: P2)

The operator can tell whether the remote endpoint is enabled, when it was last used, by
which credential, and what it called. One action (a config key, a credential revocation, or
both) shuts it off without touching the dashboard's own access.

**Why this priority**: Principle II refuses autonomy without a stop switch and legibility.
A public door into a system that runs shell as the operator needs the same, even though it
is operator-driven.

**Independent Test**: flip the endpoint's off switch without restarting. The next
connector call gets a refusal, and the dashboard still works through the tunnel. Switch it
back on, then cut off the credential (FR-016, which depends on the auth mode). Calls stop
within the window FR-016 states for that mode, and the refusal carries a reason code that
names the cause.

**Acceptance Scenarios**:

1. **Given** the endpoint is disabled (the default for a fresh install), **When** anything
   requests `/mcp`, **Then** the gateway answers `404` with a JSON body. It does not serve
   the dashboard's HTML, which is what an unknown path gets today (the SPA fallback).
2. **Given** a credential has been cut off, **When** a client presents it, **Then** the call
   is refused within the window FR-016 states for the chosen auth mode.

---

### User Story 4: A delegation started from Claude comes back somewhere (Priority: P3)

From a claude.ai chat, the operator says "get the senior developer to look at X". The
connector starts or delegates the work. Because claude.ai cannot receive Jinn's session
callbacks, the result is found later: by asking in the same or a new chat ("how did that
go?"), or on the dashboard, where the work is attributed to the connector.

**Why this priority**: write-side delegation is the most valuable remote action, and it is
also the one whose semantics differ most from an in-gateway session. Read-only use (Stories
1 and 2) is useful without it.

**Independent Test**: from Claude Code with the connector, call `delegate_task`. The
resulting Todo and session appear on the dashboard with the connector principal as the
requester. A follow-up `read_session` from a *new* chat returns the result.

**Acceptance Scenarios**:

1. **Given** a session started through the connector, **When** it finishes and would
   normally call back to its parent, **Then** the callback lands somewhere durable that the
   connector can read. It is not silently dropped (the failure mode in which a
   result never reached the session that asked for it).

---

### Edge Cases

- **Prompt injection through the connector.** The claude.ai chat that holds the connector
  may also be reading untrusted content (a web page, an email, a file). Whatever that
  content tells the model, it can do only what the tool profile allows. So:
  - It must not be able to decide any approval gate. Operator-only and COO gates exist so
    that *no model* decides them (FR-011).
  - **Any tool that starts or wakes an engine session is remote code execution by proxy.**
    Engine sessions run shell as the operator. That covers spawn, delegate, send-to-session,
    dispatch, workflow runs, and assigning a Todo (the auto-start Workflow spawns the
    assignee's session). Q2 has to be answered with that in mind.
  - Writes can execute code *indirectly*, and the route audit found five ways:
    - a new backlog Todo is picked up by idle-capacity auto-start or a `todo-status`
      Workflow;
    - a Todo comment is forwarded as a prompt into the live session;
    - any session may rewrite the text of any Todo that is about to start;
    - `update_note` can rewrite the Notes agents load as standing instructions;
    - an experiment check-in schedules a cron prompt.

    FR-013a and Q2 close all five. What remains is that text the connector writes into
    its own Todos and its own Notes folder is later *read* by agents as data, the same
    residual risk as any record a human pastes in.
  - Read tools are not harmless either: they are an exfiltration channel. Every read is
    company-wide, not scoped to the connector. The transcript reads (class T) return
    whatever any agent ever printed, including secrets. An injected chat
    can read company data and hand it to another tool in the same chat (a web fetch). The
    read set should leave out anything that returns secrets.
- **Tunnel promotes loopback.** `cloudflared` reaches the origin from 127.0.0.1, so any
  loopback-only check passes for internet traffic (the finding). `/mcp` must never
  rely on a loopback socket for authorisation.
- **Long tool calls.** Some tools block for tens of seconds. Cloudflare's proxy imposes a
  ~100 s origin response timeout on the Free plan, so a call that exceeds it fails at the
  edge, not the origin. The spec does not need streaming progress, but the runbook states
  the limit.
- **Body size.** Cloudflare Free caps request bodies at 100 MB (V8). MCP tool calls
  are small; attachment upload through the connector is out of scope.
- **Client sends an old protocol version or the legacy SSE transport.** The server answers
  in the streamable HTTP transport. Legacy SSE-only clients are out of scope (Assumptions).
- **Clock skew or expired token mid-conversation.** The client gets an auth error it can
  act on (re-auth prompt), not a generic 500.
- **Gateway restarting.** The connector gets a clean 5xx/502 from the edge, and the next
  call after the gateway is back succeeds without re-adding the connector.
- **Two chats at once.** Concurrent calls from two claude.ai chats are independent. Neither
  sees the other's in-flight state.

## Requirements *(mandatory)*

### Functional Requirements

**Transport**

- **FR-001**: The gateway MUST serve an MCP endpoint at the single path `/mcp` using the
  **streamable HTTP** transport. Every Jinn tool is request/response, so the endpoint MAY
  answer every POST with a single JSON response and MAY decline the optional GET stream
  (405). Legacy HTTP+SSE is out of scope for v1.
- **FR-002**: The endpoint MUST be reachable through the operator's **existing** tunnel and
  hostname. It MUST NOT need a second tunnel, a second hostname, or an inbound port.
- **FR-003**: The endpoint MUST be off unless explicitly enabled in config. When disabled it
  answers `404` JSON (US3-1). When enabled but its auth configuration is incomplete, it
  MUST refuse every request (fail closed). "Incomplete" means, per mode: under Q1-A, the
  Access team domain or the application AUD is unset, or the signing keys cannot be
  fetched; under Q1-B, no connector token is configured.

**Authentication**

- **FR-004**: The endpoint MUST authenticate every request with a credential **separate
  from** the gateway bearer token in `gateway.json`. That token is the full operator key to
  the HTTP API and must never be handed to a third-party client. (The tools themselves
  still reach the gateway's own routes in-process with that token over loopback. It never
  leaves the process, and FR-004 does not change it.)
- **FR-005**: The auth mode MUST work in claude.ai's custom connector UI, not only in Claude
  Code. Chosen mode: **Cloudflare Access Managed OAuth** (Q1 option A, answered 2026-09-23).
- **FR-006**: Under Q1-A, the origin MUST validate the Access assertion as follows, each
  clause tested:
  - it is read from the `Cf-Access-Jwt-Assertion` **header only**, never from the
    `CF_Authorization` cookie;
  - the signing algorithm is pinned (RS256);
  - the signature verifies against the team's published keys;
  - `aud` contains the configured application AUD;
  - `iss` equals the configured team domain exactly;
  - `exp` and `nbf` hold, within a leeway of at most 60 s;
  - the identity in the token is on a configured allow-list of emails (defence in depth
    behind the Access policy).
- **FR-007**: Because the dashboard's own browser session also carries a valid assertion to
  every path (research R3), the origin MUST also refuse browser-shaped requests to `/mcp`:
  - any request with an `Origin` header not on an explicit allow-list, which is empty by
    default. Claude Code is not a browser and sends none. claude.ai calls server-side and
    is *expected* not to send one, but that is unverified. The R5 live test records it. If
    claude.ai does send one, its exact value goes on the allow-list, and a refused Origin
    is logged as `origin-refused`, so it cannot be mistaken for a discovery failure;
  - any POST whose `Content-Type` is not `application/json`.
  This is also the DNS-rebinding guard the MCP transport spec requires.
- **FR-008**: The path `/mcp`, and whatever discovery paths the auth mode needs, MUST reach
  their server without an interactive Cloudflare challenge. The existing Access
  application's protection of every other path MUST be unchanged (US2-3).
- **FR-009**: Under Q1-A, a client with no token MUST be able to discover how to get one:
  an unauthenticated POST to `/mcp` returns `401` with a `WWW-Authenticate` header carrying
  `resource_metadata=` that points at an RFC 9728 protected-resource document whose
  `resource` equals the connector URL exactly, `/mcp` included. **This is the likeliest
  point of failure for claude.ai and an explicit unknown** (research R5). It has to be proven
  from outside before anything else is built.

**Authority and scope**

- **FR-010**: The remote endpoint MUST expose a **named, closed tool profile**. It is a
  subset of the built-in tools, defined in one place and pinned by a test, not "everything
  the built-in server has". Its contents: classes **R and L, hardened by FR-013a** (Q2 option B, answered 2026-09-23). Tools that only make sense inside
  an engine session are always excluded: `arm_heartbeat`, `stop_heartbeat`,
  `publish_attachment` and `land_on_work_item` (and the attempt-only
  `workflow_submit_output` / `workflow_extend_deadline`, which are not in the default set).
  **Also excluded from every option**: `read_knowledge`, `attach_to_work_item` and
  `create_label`.
  - `read_knowledge` reads any file inside the instance home. That includes the credential
    store, the file holding the gateway bearer, `config.yaml` (connector bot tokens, MCP
    server keys) and the key every session capability is derived from, which would let a
    caller forge any session's identity. It may enter the profile only after a separate
    change confines it to an **allow-list** of `knowledge/` and `docs/`, pinned by a test
    that the secrets directory, the gateway config file, `config.yaml`, `.env*` and
    key/token files are all refused. A deny-list at parity with managed-file reads is
    **not** enough, because that list admits the bearer file and `config.yaml`.
  - `attach_to_work_item` reads an arbitrary host path into attachment storage. A remote
    caller has no legitimate host file to attach.
  - `create_label` is already refused by the gateway for a caller without rank.
- **FR-011**: The connector MUST hold **no approval authority of any kind**. It cannot
  decide operator-only, COO-decidable or manager-routed approvals, or Workflow gates.
  No approval-deciding tool is in the profile. Separately, the gateway MUST refuse such a
  decision from the connector principal even if a tool were added, so the tool filter is
  not the only guard.
- **FR-012**: Every remote call MUST run as a **distinct, named principal**, the
  connector. It MUST NOT be the operator path, which can decide operator-only approvals.
  It MUST NOT be the shape of the gateway's top-level portal session (no employee, no
  parent, no workflow), which carries COO authority: COO-decidable approvals, COO Workflow
  gates, owner authority over every Todo, and acting-as-operator on arming (research,
  "Authority the principal must not inherit"). It MUST NOT be a manager- or
  executive-ranked employee, whose rank grants approval powers. Writes it makes MUST be
  attributed to it in the records the dashboard already shows.
- **FR-013**: Where a tool in the profile needs a caller session (spawn/delegate parent
  linkage, callbacks, own-descendant scoping on stop), the connector MUST have a durable
  anchor that satisfies those guards **without** acquiring the authority FR-011/FR-012
  exclude. Callbacks addressed to it MUST be recorded where the connector can read them
  back (US4), not dropped. If no such anchor can be made, the tools that need it leave the
  profile.

- **FR-013a** *(withdrawn by a later amendment; kept for the record)*: Nothing the connector writes may start, steer or re-instruct an engine
  session. This covers the Todo ledger, Notes and experiments. If class L is in the
  profile (Q2), the gateway MUST enforce all of the following for the connector principal.
  Each is tested against the gateway, not only the tool filter. The route audit in
  research.md is the evidence for each clause.
  1. Every Todo it creates is born non-startable: `autoStart:false` **and** the
     `no-auto-start` label. **No** `todo-status` Workflow trigger starts a run for it,
     whether or not that trigger filters on `autoStart`.
  2. Its Todo edits and label changes are limited to Todos it created. It can never remove
     `no-auto-start`. (Today any session may edit the text of any Todo.)
  3. Its comments are recorded but never forwarded into a live session by comment
     steering, and a comment from it may not carry file attachments.
  4. Its Note writes are confined to one connector-owned folder under `knowledge/`, and it
     can update only Notes it created. It cannot create or rewrite the state file,
     per-employee files, or any other Note agents load as instructions.
  5. Experiment writes that create or rewrite a check-in schedule are not in L at all
     (see Q2, class X).
  The operator turns a connector-created Todo into running work the normal way: assign
  it, or remove the label, from the dashboard or a Jinn chat.

**Observability and control**

- **FR-014**: The gateway MUST log each remote request with: timestamp, principal, client
  identity (as reported in `initialize`), method, tool name, outcome, duration, and on
  refusal a machine-readable reason code (`disabled`, `misconfigured`, `no-credential`,
  `bad-credential`, `expired`, `cut-off`, `origin-refused`, `tool-not-in-profile`, …).
  Credential values MUST never be logged, not even as prefixes.
- **FR-015**: The operator MUST be able to see whether the endpoint is enabled and when it
  was last used, without reading raw logs. A CLI command is sufficient (Footprint Ladder
  rung 2).
- **FR-016**: The operator MUST be able to cut the connector off in one action with no
  gateway restart. What "effective" means depends on the auth mode:
  - **Under Q1-A**, the origin cannot see revocation of an Access token, and Access
    documents no revocation mechanism. Cut-off is therefore the endpoint's off switch or an
    origin-side deny-list of identities, read per request, effective on the **next
    request**. Revoking the Access session or removing the policy stops *new* tokens.
    Tokens already issued stay valid until the Access token lifetime ends, which the
    runbook sets to at most 15 minutes. Once the origin switch has been flipped, those
    tokens are refused there anyway.
  - **Under Q1-B**, revoking the token is effective on the next request.

**Deployment**

- **FR-017**: The repository MUST ship a runbook (in `docs/`) that covers:
  - the Cloudflare Access changes (Managed OAuth settings, redirect allow-list including
    both Claude callbacks and the localhost/loopback toggles, token lifetime), and **that
    no tunnel ingress change is needed** (research R6);
  - the zone settings that break server-to-server calls, and the narrow exemption for each;
  - the claude.ai and Claude Code steps for adding the connector.
  It MUST use placeholders only (constitution, Hard Constraints).
- **FR-018**: The deployment MUST keep the invariants: `/api/internal/*` stays 404 at
  the ingress, and no rule sets `originRequest.httpHostHeader`.

### Key Entities

- **Connector principal**: the identity that every remote MCP call runs as. It has a
  stable name shown in the dashboard, the tool profile it may use, and its current and
  revoked credentials.
- **Connector credential**: what a client presents. Under Q1-A it is an Access-issued
  assertion. Jinn stores nothing, and keeps only the allow-list and deny-list of
  identities (FR-006, FR-016). Under Q1-B it is a static token that Jinn issues. Jinn
  stores it only as a hash, with when it was issued and last used, and whether it has been
  revoked.
- **Remote tool profile**: the closed list of tool names the endpoint serves. It is part of
  the code, not a config key nobody sets (Principle V).
- **Remote call record**: one log line per request, as in FR-014.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From outside the LAN and the tailnet, the operator adds the connector in
  Claude Code and in claude.ai and completes a read (the Todo list) in each, following
  only the shipped runbook, in under 15 minutes per client.
- **SC-002**: 100% of requests without a valid credential are refused, and 0 reach a tool
  handler. This is demonstrated by the verification matrix in the plan, run against the
  public hostname, not only localhost.
- **SC-003**: The dashboard's Access protection is unchanged: an unauthenticated browser
  request to `/` still lands on the Access login, and checks V1, V2, V4 and V5
  still pass.
- **SC-004**: After the operator's cut-off action (FR-016), the next request is refused.
  Under Q1-A, a new token cannot be obtained once Access has been revoked, and no
  previously issued token outlives the configured Access token lifetime.
- **SC-005**: Every write made through the connector during testing can be traced on the
  dashboard to the connector principal, with no unattributed rows.
- **SC-006**: A typical read tool call from claude.ai completes in under 3 seconds end to
  end on a warm gateway.
- **SC-007**: The connector principal gets `403` on each of: a COO-decidable Todo approval,
  an operator-only Todo approval, a COO-reserved Workflow gate, and an update to a Todo it
  does not own. This is tested against the gateway directly, not only through the tool
  filter.
- **SC-008**: Each of the following is tested against the gateway:
  - A Todo created by the connector is still unstarted after two idle-capacity ticks with
    spare allowance, and no `todo-status` Workflow run exists for it.
  - A connector comment on a Todo with a live delegated session does not reach that
    session.
  - The connector gets `403` on each of: removing `no-auto-start` from any Todo; editing a
    Todo it did not create; `update_note` on a pre-existing Note; `create_note` outside its
    folder; a comment carrying an attachment.

## Assumptions

- **Single operator, personal use.** One human, one Access identity, one or a few
  connector credentials. Multi-user and multi-org connectors are out of scope. So are
  consent screens for third parties and any public listing.
- **Reuse the existing Cloudflare setup.** Same tunnel, same hostname, same Access account.
  Only the `/mcp` path gets different treatment. A separate hostname is a fallback only if
  path-scoped Access cannot be made to work (plan research item).
- **In-process, not a second daemon.** The endpoint is served by the gateway itself. It
  reuses the same JSON-RPC handling and tool definitions as the stdio server, so there is
  one implementation of each tool. (A plan-level choice, recorded here because it bounds
  scope.)
- **Tools only.** No MCP resources or prompts in v1. The stdio server offers only tools
  today, and nothing asks for more.
- **Streamable HTTP only.** Legacy SSE is skipped: every current Claude client speaks
  streamable HTTP, and the brief allows it.
- **Anthropic's own "MCP tunnels" preview** is out of scope. It targets the API/agent
  platform, is gated behind an access request, and does not serve claude.ai custom
  connectors.
- **Cloudflare sees plaintext.** As already accepted (decision D5), traffic through
  the tunnel is decrypted at Cloudflare's edge. The connector adds tool arguments and
  results to what crosses that edge. It does not add a new party.

## Open Questions for the Operator

### Q1: Auth mode for v1

**Context**: FR-005. The whole hostname is behind Cloudflare Access with a one-time-PIN login.
claude.ai calls from Anthropic's servers (published range `160.79.104.0/21`), which cannot
complete that login, unless Access itself acts as an OAuth server towards the client, which
it can (research.md R1).

| Option | What it is | Work | claude.ai | Claude Code | Risk |
| --- | --- | --- | --- | --- | --- |
| **A. Access Managed OAuth** (recommended) | Turn on Access's *Managed OAuth* for `/mcp`. Access serves the OAuth discovery metadata, answers non-browser clients with `401` + `WWW-Authenticate`, and runs DCR against a redirect-URI allowlist. The login screen is the existing Access login. The origin validates the `Cf-Access-Jwt-Assertion` JWT (signature against the team JWKS, `aud` = the app's tag, issuer, expiry) on every request. | Low: dashboard config plus JWT validation | Yes (`oauth_dcr`) | Documented: Managed OAuth has "Allow localhost/loopback clients" toggles, and Claude falls back to DCR. To confirm live (R2) | Depends on a Cloudflare feature. JWT validation must be exact |
| **B. Access bypass on `/mcp` + static bearer** | An Access bypass policy on `/mcp` only. Jinn checks its own connector token in `Authorization: Bearer`. | Low | Beta "static headers" only | Yes (`--header`) | `/mcp` is guarded by one secret alone, with no identity check in front |
| **C. Access bypass + key in URL path** (`/mcp/<key>`) | Same as B, but the key rides in the URL so claude.ai uses "No auth". | Lowest | Yes | Yes | Key sits in every URL log (edge, claude.ai config). Needs rotation discipline |
| **D. Jinn implements OAuth 2.1 + PKCE + DCR itself** | Jinn becomes an authorization server. | High | Yes | Yes | The most code in the auth path, which is the code this repo should write least of |

**Recommendation**: **A for claude.ai**, because it keeps an identity check in front of the
door (the principle: Jinn's own credential is never the only thing between the internet
and a shell) and needs no auth server written here. Claude Code should use the same path through the
localhost/loopback toggles. The caveat: with those on, any local process can register a
client, so the Access login is the thing that still gates it. If the live test fails,
Claude Code falls back to an Access **service token** sent as headers, which keeps Access in
front (R3), not to option B. **The one blocking unknown for A is discovery (FR-009, R5)**: if
claude.ai cannot find the protected-resource metadata through Access, A does not work until
that is fixed (fallbacks in R5). C and D are not recommended.

### Q2: What may the connector do in v1?

**Context**: FR-010. The injection edge case applies throughout: whatever a claude.ai chat
reads can steer these tools. The profile is listed by name in classes so the answer is a
choice of classes. Session-bound tools are always excluded (FR-010), and approval deciders
always are (FR-011).

Every row below comes from the route audit in research.md, not from tool names.

| Class | Tools | Risk under injection |
| --- | --- | --- |
| **R: read** | `list_work_items`, `get_work_item`, `search_work_items`, `get_work_item_tree`, `list_work_item_comments`, `list_work_item_attachments`, `list_sessions`, `search_sessions`, `list_employees`, `get_employee`, `find_employees`, `list_departments`, `list_notes`, `read_note`, `search_knowledge`, `list_workflows`, `get_workflow`, `list_workflow_runs`, `get_workflow_run`, `list_cron_jobs`, `get_cron_run_history`, `cost_report`, `list_labels`, `list_experiments`, `get_experiment`, `list_heartbeats`, `list_files`, `read_file` | Company-wide metadata, Notes and managed files. No secret *files* are reachable. Agent-written text still is: comments, and `get_workflow_run` with `view=full` returns node outputs, which are agent output just like transcripts. Exfiltration of company data is the risk |
| **T: transcript read** | `read_session`, `get_message_context`, `search_messages` | Raw transcripts of **any** session, tool output included, so any secret an agent ever printed. Needed for "how did that go?" (US4) |
| **L: ledger write** (only with FR-013a) | `create_work_item`, `edit_work_item`, `comment_work_item`, `label_work_item`, `link_work_items`, `unlink_work_items`, `create_note`, `update_note`, `record_reading`, `conclude_experiment` | With FR-013a: pollutes the connector's own records, and nothing starts, is steered or is re-instructed. **Without FR-013a this class is code execution** (five paths, see the edge cases) |
| **X: code-executing** | `spawn_session`, `send_to_session`, `delegate_task`, `dispatch_work_item`, `assign_work_item` and status moves via `update_work_item` (auto-start), `start_workflow_run`, `rerun_workflow_run`, `retry_workflow_node`, `fire_workflow_event`, `set_work_item_dispatch`, `create_experiment`, `update_experiment` (check-in cron) | **Remote code execution by proxy**: each starts, wakes or schedules an engine session that runs shell as the operator |
| **D: destructive / control** | `archive_work_item`, `stop_session`, `cancel_workflow_run`, `disable_workflow` | Loses work or state |
| **A: automation-defining** | `create_workflow`, `update_workflow`, `duplicate_workflow`, `retire_workflow`, `enable_workflow` | Persistent behaviour with triggers, which outlives the chat. `enable_workflow` re-arms triggers that spawn sessions |
| **C: outbound comms** | `send_connector_message` | Messages leave the company (CLAUDE.md treats public communication as operator-only) |
| **P: approval requests** | `request_work_item_approval`, `escalate_work_item_approval` | Opens gates for someone else to decide. Low risk, and only meaningful for a Todo owner |
| *Excluded from every option* | `read_knowledge`, `attach_to_work_item`, `create_label` (FR-010), the approval deciders (FR-011), and the session-bound tools (FR-010) | — |

| Option | Classes | Implication |
| --- | --- | --- |
| **A. Read-only** | R | Company data exfiltration is the only risk. FR-013a is not needed. US4 moves to v2 |
| **B. Read + ledger, hardened** (**recommended**) | R, L + FR-013a (add T only if you accept that transcripts can hold printed secrets) | The operator can capture and annotate work from any chat. Connector Todos are born non-startable, and its comments never steer. Anything *running* still needs a human to assign it, on the dashboard or in a Jinn chat. No code executes on the connector's say-so. Costs four gateway rules (FR-013a clauses 1–4). US4 (delegating from claude.ai) moves to v2, and FR-013's durable anchor is needed only if X is chosen |
| **C. Read + ledger + code-executing** | R, T, L, X | US4 works, and so does "get the senior dev on it" from claude.ai. **This is remote code execution by proxy from any chat that also reads untrusted content.** Take it only knowingly, ideally with the connector enabled only in chats that read nothing else |
| **D. Everything except approvals** | R, T, L, X, D, A, C, P | Not recommended |

### Q3: Should connector writes show as the operator, or as their own principal?

**Context**: FR-012 requires a distinct principal ("claude.ai connector") so the ledger shows
where a write came from, and it requires that principal to hold *no* inherited COO,
manager or operator authority. It is not only a different label. The alternative is that
connector writes show as the operator. That is simpler, but it makes a model-initiated
write indistinguishable from one the operator made by hand, and it hands the connector the
operator's approval powers. **Recommendation**: distinct principal. Answer only if you
disagree.
