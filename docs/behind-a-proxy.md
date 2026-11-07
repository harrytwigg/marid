# Running Marid behind a tunnel or reverse proxy

Sign-in is rate limited. How well that works when a tunnel or reverse proxy sits in front of the gateway
depends on one setting, `gateway.trustedProxies`. This page says what happens with and without it, and how to
set it for common setups. It only matters where gateway auth is required, which is where accounts exist.

## What the gateway limits

| Limit | Applies to | Counted by |
|---|---|---|
| 5 failed sign-ins per 15 minutes | one email address | the email address |
| 20 failures per 15 minutes | one client IP | the client's address (sign-in, invite and reset links) |
| 2 password hashes running, 16 waiting | the whole gateway | none: beyond that, `429` with `Retry-After` |
| 100 failed sign-ins per 15 minutes | the whole instance | none (see below) |

A refused request is never counted, and a correct password gives its attempt back.

The last row is the instance budget. Once 100 sign-ins have failed within 15 minutes, a new sign-in from an
address that has **never signed in successfully** (within the last 30 days) is answered `429` with
`Retry-After`, even with the right password, until the window has passed. An address that has signed in
before is still let in: its password is still checked, and it can still be locked by the per-email and per-IP
limits. The gateway logs one warning when the budget trips. Paired devices, the gateway token, and members or
owners who are already signed in never go through sign-in, so none of this affects them.

## Without `trustedProxies` (the default)

The gateway believes nothing a request header says about who sent it, so it uses the address of the socket.

- A client connecting directly is limited per address, as above.
- Behind a proxy or tunnel running on the same machine, every client arrives from the loopback address. That
  address stands for many people, so it gets **no per-IP bucket** (one person's failures would otherwise lock
  everyone out). What remains is the per-email limit, the hashing cap and the instance budget.
- Behind a proxy in Docker or on another host, every client arrives from the proxy's address (for Docker, the
  bridge's NAT address). That is one shared IP bucket: 20 failures from anyone lock new sign-ins from everyone
  who comes through it for 15 minutes. Setting `trustedProxies` fixes that.
- Nobody counts as "has signed in before" from a loopback address, so while the instance budget is spent,
  sign-ins through a local tunnel are refused until it clears. Paired devices still work.

## With `trustedProxies`

```yaml
gateway:
  trustedProxies: ["127.0.0.1", "::1"]   # IP addresses or CIDR ranges, IPv4 and IPv6
  clientIpHeader: cf-connecting-ip       # optional: one header your proxy sets
```

Both keys are read live, so a change to `config.yaml` applies to the next request. An entry that is not a valid
IP address or CIDR range is reported when the config loads.

When a request's direct peer is in `trustedProxies`, the gateway takes the real client's address from a
forwarded header. Otherwise the header is ignored entirely.

- **With `clientIpHeader`**: that one header is used, and `X-Forwarded-For` is not read. It must appear exactly
  once and hold exactly one IP address. If it is missing, repeated, a comma-separated list or not an address, the
  proxy's own address is used (which counts as shared).
- **Without it**: `X-Forwarded-For` is read from right to left, skipping addresses that are themselves in
  `trustedProxies`; the first address that is not is the client. An unreadable entry stops the walk. Ports
  (`203.0.113.9:4000`, `[2001:db8::1]:443`) are stripped. If every address is a trusted proxy, the leftmost one is used.

Real clients then get the per-IP limit, and an address that has signed in successfully is exempt from the
instance budget for 30 days. An address that is itself a trusted proxy or a loopback address is still treated
as shared: no per-IP bucket, no exemption. The resolved address is also what a member session records.

This is used for sign-in rate limiting and for the address on member sessions only. It does not change which
requests count as local (the hook endpoint, pairing, same-origin checks all keep using the socket).

> **Only list addresses that are your own proxies.** Anyone who can connect to the gateway from a listed address
> can claim to be any client. Do not list a broad range, and do not expose the gateway port directly to the
> network when you rely on this: a direct connection from a listed address skips the proxy. In Docker, the
> published port is reached through the bridge's NAT address, so trusting that address trusts everyone who can
> reach the port. Put the proxy in front and keep the gateway bound to loopback or a private network.

## Examples

The proxy must set the header on every request and overwrite or append to anything the client sent. Check your
proxy's documentation for exactly how it treats headers a client supplies.

**cloudflared (Cloudflare Tunnel) on the same machine.** The tunnel connects from loopback and Cloudflare sets
`CF-Connecting-IP` to the visitor's address:

```yaml
gateway:
  trustedProxies: ["127.0.0.1", "::1"]
  clientIpHeader: cf-connecting-ip
```

**ngrok on the same machine.** The agent connects from loopback. It sends `X-Forwarded-For`; check ngrok's
documentation for the headers your plan sets:

```yaml
gateway:
  trustedProxies: ["127.0.0.1", "::1"]
```

**Caddy on the same machine.** `reverse_proxy` adds `X-Forwarded-For` for the client it sees:

```caddyfile
marid.example.test {
  reverse_proxy 127.0.0.1:7777
}
```

```yaml
gateway:
  trustedProxies: ["127.0.0.1", "::1"]
```

**nginx.** Make nginx append the client to `X-Forwarded-For`. Without this line nginx passes along only what the
client sent, which anyone can forge:

```nginx
location / {
  proxy_pass http://127.0.0.1:7777;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

```yaml
gateway:
  trustedProxies: ["127.0.0.1", "::1"]   # or nginx's own address, if it runs elsewhere
```

If your proxy runs on another host or in a container, list its address (or its network's range) instead of
loopback, and make sure only that proxy can reach the gateway. For platforms that set a single client header
(for example `fly-client-ip` on Fly.io, or `x-real-ip` from a proxy you configured to set it), use
`clientIpHeader` with that name and check the platform's documentation that it overwrites a client-supplied copy.

Whatever you set, the per-email limit, the hashing cap and the instance budget apply.
