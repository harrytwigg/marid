# Remote MCP connector

Jinn can serve a subset of its tools as a remote MCP server at `/mcp`. That lets the
operator add the instance as a **custom connector** in claude.ai, Claude Desktop / Cowork
and Claude Code. Spec: `specs/004-remote-mcp-connector/`.

This page assumes the gateway is already published through a Cloudflare Tunnel with a
Cloudflare Access application in front of its hostname. Placeholders used throughout:

| Placeholder | Meaning |
| --- | --- |
| `<host>` | The public hostname the tunnel serves, e.g. `jinn.example.com` |
| `<team>` | Your Zero Trust team domain, e.g. `acme.cloudflareaccess.com` |
| `<aud>` | The Access application's **Application Audience (AUD) tag** |
| `<you@example.com>` | The identity allowed by the Access policy |

## What it exposes, and what it cannot do

The connector is the operator's own door into Jinn, so it acts with the operator's
standing on the Todo ledger. It sees **reads** (Todos, sessions metadata, org, Notes,
Workflows, cron, cost, managed files), **ledger writes**, and **session control**:

- create, edit, comment on, label and link any Todo, and assign it (`assign_work_item`);
- write and update Notes anywhere under `knowledge/`;
- tail a session's transcript (`read_session`, `last` = how many recent messages;
  `last: 0` returns the whole transcript, uncapped);
- message a session (`send_to_session`); the session answers in its own transcript;
- hand a named employee new work (`delegate_task`), which mints the Todo and starts
  that employee's session. Given an existing `workItemId` it hands on that Todo instead,
  whoever created it and whatever its status, including one in `in_review`. A pending
  approval on it stays pending: only the operator surface decides it.

What still holds for the connector's principal, enforced by the gateway and not just the
tool list:

- It can call only the routes its tools use. Anything else gets `403`.
- It holds no approval authority, and it is never treated as the COO portal.
- It never runs an engine itself, and never reads arbitrary instance files
  (`read_knowledge`).
- Messages it sends go through the ordinary agent-to-agent guards (a per-sender rate cap
  and a relay hop budget).

## 1. Configure the gateway

In `config.yaml`:

```yaml
gateway:
  remoteMcp:
    enabled: true
    resourceUrl: https://<host>/mcp
    access:
      teamDomain: <team>
      aud: <aud>
    allowedEmails:
      - <you@example.com>
    # deniedEmails: []      # per-request cut-off (see "Cutting it off")
    # allowedOrigins: []    # leave empty; no real client sends an Origin
```

Config reloads live, so no restart is needed. With `enabled: false` (the default), `/mcp`
answers `404`. With `enabled: true` but the Access pair or allow-list missing, every
request is refused as `misconfigured`.

Finding `<aud>`: in the Zero Trust dashboard, open Access → Applications → your app →
Overview, and read "Application Audience (AUD) Tag". It is also the `kid` query parameter
on the Access login redirect for the hostname.

## 2. Configure Cloudflare Access

In Zero Trust → Access → Applications → *the app that covers `<host>`* → **Advanced
settings → Managed OAuth**:

- Turn **Managed OAuth on**.
- Under **Allowed redirect URIs**, add both:
  - `https://claude.ai/api/mcp/auth_callback`
  - `https://claude.com/api/mcp/auth_callback`
- Turn on **Allow localhost clients** and **Allow loopback clients** (for Claude Code).
  With these on, any local process can register a client, so the Access login is what
  still stops it. Keep the allow policy to your identity only.
- Set **Access token lifetime** to 15 minutes or less. This bounds how long an issued
  token outlives a cut-off made in Access (the gateway-side cut-off is immediate).

Browsers keep getting the normal Access login: Managed OAuth only changes the answer to
non-browser clients (a `401` pointing at the OAuth metadata).

The tunnel ingress needs **no change**. Every path except `/api/internal/` already
reaches the gateway.

## 3. Zone security settings

claude.ai calls from Anthropic's servers, which cannot solve a challenge page.

- **Bot Fight Mode** cannot be skipped by WAF rules, but it does not trigger when an **IP
  Access rule** matches first. Add an IP Access rule: **Allow `160.79.104.0/21`**
  (Anthropic's outbound range). Do not add `2607:6bc0::/48`, which is an inbound range.
- "I'm Under Attack" mode and a high Security Level also challenge. Keep them off for the
  zone, or scope them away from `/mcp`.
- Claude Code calls from your own network. If Bot Fight Mode flags it, the same allow
  rule approach applies to your IP.

## 4. Add the connector

**Claude Code** (test here first):

```bash
claude mcp add --transport http jinn https://<host>/mcp
```

Then run `/mcp` in Claude Code to authenticate. A browser opens the Access login.

**claude.ai**: Settings → Connectors → Add custom connector → URL
`https://<host>/mcp` → Connect → sign in on the Access page.

## 5. Verify

From a machine outside your network:

```bash
# Discovery: expect 401 and a WWW-Authenticate that points at OAuth metadata.
curl -i -X POST https://<host>/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# The metadata claude.ai probes for. The `resource` must be exactly https://<host>/mcp.
curl -i https://<host>/.well-known/oauth-protected-resource/mcp
curl -i https://<host>/.well-known/oauth-protected-resource
```

If the probes come back as an Access login or `401` rather than JSON, Access is not
letting the metadata through. Add an Access application for exactly those two paths
with a **Bypass** policy. The document is public by design and says only where to
authenticate.

On the gateway host:

```bash
grep '\[remote-mcp\]' <JINN_HOME>/logs/gateway.log | tail   # one line per request, reason codes on refusals
curl -s -H "Authorization: Bearer $(jq -r .token <JINN_HOME>/gateway.json)" http://127.0.0.1:7777/api/remote-mcp
```

Refusal reason codes: `method`, `origin-refused`, `content-type`, `misconfigured`,
`no-credential`, `bad-credential`, `expired`, `cut-off`, `not-allowed`.

The first request from claude.ai also shows whether it sends an `Origin` header. If it
does and is refused as `origin-refused`, put that exact value in `allowedOrigins`.

## Cutting it off

Any of these works without a restart:

- `enabled: false`: `/mcp` answers `404` on the next request.
- Add the email to `deniedEmails`: that identity is refused (`cut-off`) on its next
  request.
- In Access, revoke the user's sessions or remove the policy. That stops new tokens. Ones
  already issued stay valid until the token lifetime ends, unless one of the two above is
  also in place.

## Identity inside Jinn

Each allowed email gets one **connector anchor session** (source `remote-mcp`, titled
"Remote MCP connector (<email>)"). It shows in the dashboard's direct group, and every
write the connector makes is attributed to it. It never runs an engine: a message sent
to it (a session replying, or a delegated session's completion callback) is recorded in
its transcript, and the anchor goes back to idle without running anything.
`read_session` on the anchor's id reads those back.
