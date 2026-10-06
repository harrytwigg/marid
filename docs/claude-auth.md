# Claude authentication on a gateway host

How the Claude engine stays logged in on an unattended gateway, what the gateway
does when it stops being logged in, and the one step it cannot do for you.

## What Claude Code keeps, and who refreshes it

Claude Code stores an OAuth pair per profile — on Linux in
`$CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude/.credentials.json`),
on macOS in the login Keychain:

| field | lifetime | what it is for |
|---|---|---|
| `accessToken` / `expiresAt` | hours | every API request |
| `refreshToken` / `refreshTokenExpiresAt` | weeks | minting the next access token |

**Claude Code refreshes the pair itself.** When a `claude` process starts, or
gets a 401, it exchanges the refresh token for a new pair and rewrites the file.
Refresh tokens rotate: the old one is consumed by the exchange. The gateway
never calls the refresh endpoint — a second refresher racing the CLI's own is
exactly how a refresh token gets consumed by one process and lost by the file.

Two consequences shape everything below:

- An **expired access token on disk is routine.** Between launches the file
  spends most of its time expired; the next launch fixes it. It is not a fault
  and the gateway does not treat it as one.
- A **refresh that fails is fatal and unattended-unfixable.** The CLI reports
  `authentication_failed` ("Login expired · Please run /login") and every
  further launch does the same until a human runs `claude auth login`.

## What the gateway does

`packages/jinn/src/sessions/claude-auth-watch.ts` (side effects) over
`packages/jinn/src/shared/claude-auth.ts` (reads the file) and
`claude-auth-outage.ts` (the ledger, at `$JINN_HOME/tmp/claude-auth-outage.json`).

1. **Observe.** Every Claude turn reports how it ended. `authentication_failed`
   or `oauth_org_not_allowed` opens an outage for the session's *scope* — the
   gateway host (`local`), a local employee's named profile
   (`local:<profile key>`, from `claudeConfigDir`), or a remote employee's
   `user@host[:profile]`. A turn that authenticated closes it.
2. **Alert once.** The first failure of an outage sends one operator message
   naming the host, the reason, what it costs (every Claude turn and cron job
   there), and the fix. The outage then counts; it does not re-send. Recovery
   sends one message with the duration and the tally. An outage survives
   `jinn restart` without re-alerting.
3. **Refuse doomed launches.** Turn preflight refuses a *local* Claude launch
   when the disk states outright that it cannot work (no credentials file;
   refresh token past its own expiry) or when a launch already proved it and
   nothing has changed since (access token expired, same pair failed within the
   last hour). The refusal settles the session as failed with the fix in the
   error, so cron history records a failed run without spawning a CLI. It is a
   cooldown, not a lock: one launch per hour re-probes, and a login lifts it
   immediately because the pair on disk changes. Remote employees are never
   refused — their credentials are on a host the gateway cannot read. A turn
   on a local named profile is checked differently: the profile directory must
   exist and hold a login (its Keychain item by name on macOS, its
   `.credentials.json` elsewhere, never reading the secret), and the refusal
   names the `CLAUDE_CONFIG_DIR=<dir> claude`, then `/login`, that fixes it.
4. **Prefer a fallback engine.** The failure also records `claude` as
   unavailable in engine health for the recheck window, so new sessions with an
   engine chain start on the next healthy engine and the dashboard shows why.
   A named profile's failure is recorded under its own account,
   `claude:<profile key>`, and moves nothing else.
5. **Warn ahead of the predictable expiry.** The 15-minute engine-health tick
   checks `refreshTokenExpiresAt` and sends one warning 48 hours before it — the
   only credential expiry that is both foreseeable from the file and fatal.
6. **Read each account's limits without touching its login.** The Limits page
   reads every Claude account with its own access token: the default account's
   as before, a named profile's from its own Keychain item or
   `.credentials.json` (never `$CLAUDE_CODE_OAUTH_TOKEN`), and a remote login's
   over SSH, where only the access token and its expiry leave the host. The
   token is used in memory for the one usage call. The gateway never refreshes
   a token, because refreshing rotates the refresh token under Claude Code; an
   expired one just means no live reading until a session on that account
   refreshes it. The signed-in check before a turn stays existence-only.
7. **Read the catalog honestly.** Model discovery returning 0 models no longer
   says "run `claude login`" unless logging in is the fix; an expired access
   token is logged at info as what it is, and the last discovered catalog is
   kept rather than replaced with offline aliases.

### Where alerts go

`notifyOperatorChannel` resolves its target in this order:

1. `notifications.connector` + `notifications.channel`
2. `cron.alertConnector` + `cron.alertChannel`
3. a Telegram connector whose `allowFrom` lists exactly one user

With none of those, alerts are logged at warn and dropped. Set `notifications`
explicitly; the fallbacks exist so a working connector is used rather than
nothing, not as a recommendation.

## The manual step

On the gateway host, as the user the gateway runs as:

```
claude auth status      # loggedIn:false, or a failing turn, means the next line
claude auth login
```

If the Telegram connector has `telegramAuth.enabled: true` with the operator in
`ownerUserIds`, `/auth claude` to the bot runs the same login from the phone,
and the outage alert says so.

There is no unattended equivalent. `claude auth login` is a browser OAuth
flow; a refresh token that has been consumed or revoked cannot be recovered by
software on the host.

## Why a refresh can be refused

An expired access token is ordinary: Claude Code refreshes it on the next
launch. The failure this design exists for is the refresh itself being refused
("Login expired · Please run /login"). Every launch after that fails
identically with `authentication_failed` until someone logs in again, and
anything scheduled or parked on a usage limit wakes into the same failure.

What is known about it:

- The access token on disk can be valid at one model-discovery probe and
  expired at the next (14 models, then 0) — an ordinary end-of-lifetime.
- The first launch after expiry fails within seconds: Claude Code attempted its
  refresh and the refresh token was refused. Whatever consumed the refresh
  token did so before that launch, so it is not a race between retries of
  parked sessions.
- Only a fresh login (a new pair, a new `profileFetchedAt`) recovers.
- Nothing else on the host reads or refreshes that file; the gateway's own
  readers use the access token only. Remote employees log in on their own host.

What is not known is *why* the refresh token was refused. Claude Code does not
log the refresh response by default. The two candidates are a rotation race —
several long-lived `claude` processes parked on a usage limit share the file
through the hour in which the access token expires, and Claude Code refreshes
proactively ahead of expiry; a process refreshing from stale in-memory
credentials after another has already rotated the pair would be refused, and
some providers revoke the whole token family on reuse — and a server-side
revocation. The evidence cannot separate them. That is why the fix is built
around *detecting* the refusal, refusing further launches on the same dead
pair, and alerting with the fix, rather than around a cause we would be
guessing at.

The "0 models — no usable OAuth token" warning is not a signal of this: it
fires whenever the access token is merely expired between launches, including
on a healthy gateway.
