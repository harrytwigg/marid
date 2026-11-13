# opencode accounts (`engines.opencode.accounts`)

Several subscriptions to the same opencode provider (for example two OpenCode
Go workspaces, each with its own API key), declared as named accounts. Chains
name each account's models, the Limits page shows each account, and an
exhausted account is routed around. This is the opencode counterpart of
`engines.claude.accounts`.

## Findings that decide the design (OpenCode 2.0.32 and 1.19.0)

Verified against the real binaries, with a local capture server standing in
for the provider endpoint.

1. **opencode's own connections are global.** An integration can store
   several credentials, but exactly one is `active`, and that flag lives in
   opencode's database. A running server reads the active credential for each
   request. `opencode auth switch`, run by any process against the same data
   directory, changes the key for every session at once, including turns
   already in flight. No config key selects a stored credential; the only
   selector is the global `POST /api/credential/:id/activate`. Connections
   can't be used per session or per chain link.
2. **The console sign-in outranks the Go key.** When an `opencode` (console)
   OAuth sign-in and an `opencode-go` API key are both stored, the built-in
   `opencode-go` provider sends the console access token plus
   `x-opencode-org-id`, and never the Go key. So which Go workspace the
   built-in provider bills is decided by the console sign-in, not by the
   stored key.
3. **A custom provider id (an alias) uses only its own key.** An alias with
   `"apiKey": "{env:NAME}"` sends exactly that key. With the variable unset it
   sends no credential at all (Go answers `OpenCode Go requires an API key`).
   It never falls back to the console sign-in or to the stored Go key. The Go
   endpoint validates the alias's key itself: `Invalid credential` for a bad
   key, `This API key has expired…` for an expired one.
4. **Aliases already send Go's session headers.** On 2.0.32 and 1.19.0, an
   alias on the openai-compatible and anthropic SDKs sends
   `x-opencode-session` (and `x-opencode-session-id`; 2.x adds
   `x-session-affinity`/`x-session-id`). The value is stable within a session
   and the same as for the built-in provider. Nothing extra is needed for
   routing or prompt caching.
5. **Go serves models on four endpoints.** In the 2.0.32 catalogue the Go
   models use openai-compatible, openai, anthropic and google SDKs on
   `…/go/openai/v1`, `…/go/anthropic/v1` and `…/go/google/v1beta`. An alias
   needs the per-model SDK and endpoint:
   - **2.x** honours a per-model `"provider": {"npm": "@ai-sdk/<sdk>", "api": "<url>"}`.
     `@ai-sdk/*` names map onto 2.x's built-in `@opencode/ai/providers/*`.
   - **1.x** honours the per-model `npm` but **ignores** a per-model `api` or
     `options.baseURL`. Every model is sent to the provider-level `baseURL`.
     On 1.x an alias can therefore serve only the models on its provider-level
     endpoint.
6. **An alias model has no price unless it is given one.** Without a `cost`
   block, opencode records a turn on the alias at $0, so the usage ledger
   would never move. A config `cost: {input, output, cache_read, cache_write}`
   (USD per million tokens) is honoured on 2.x and recorded on the turn. The
   per-model `limit` and `variants` are honoured too. A model's `id` maps the
   alias's model key onto the upstream model id.
7. **The catalogue lists a provider only when it can authenticate.** 2.x
   `api model.list` omits `opencode-go` on a host with no Go or console
   credential. In the 2.x records, `settings` can carry a resolved `apiKey`,
   so any parser of them must drop it.

## Decision: aliases

Each account is an opencode **custom provider id** that the gateway stages
into the per-session config it already writes. The block is cloned from the
base provider's catalogue entry, and its key is passed by environment
reference.

- Native connections are ruled out by finding 1: they are global.
- One credential store per account (a separate opencode data directory per
  account) would isolate keys, but it splits session history by account: a
  hop between accounts could not resume the conversation. Every account would
  also need its own server, and the console-precedence rule (finding 2) would
  still apply inside each store.
- Aliases keep one data directory and one config file. A hop
  `opencode-go/x → opencode-go-b/x` is "same thread, other model", so the
  conversation carries over. Health is already keyed per provider
  (`opencode/<provider>`).

## Config

```yaml
engines:
  opencode:
    accounts:
      go-b:                                  # account name: [A-Za-z0-9][A-Za-z0-9._-]*
        provider: opencode-go-b              # provider id chains name: opencode-go-b/<model>
        base: opencode-go                    # clone this provider's endpoints, SDKs, prices and limits
        keyEnv: OPENCODE_GO_B_API_KEY        # read from the gateway's environment at launch
        label: Go (second workspace)         # optional display name
        models: [deepseek-v4.1-flash, mimo-v2.6-pro]   # optional subset of the base's models; default all
        usageLimits:                         # optional; see Metering
          monthlyUsd: { "*": 100, "mimo-v2.6-pro": 15 }
      go-a:
        provider: opencode-go                # a built-in provider, declared for a name, metering and a card
```

Rules, checked at load time (`shared/opencode-accounts-config.ts`, with the
other config checks; a config that breaks one is refused like any other config
mistake):

- `provider` must match `^[a-z0-9][a-z0-9._-]*$`. It must be unique across
  accounts, must differ from `base`, and must not be `opencode`.
- **With `base`:** `keyEnv` is required and must match `^[A-Z_][A-Z0-9_]*$`.
  An inline key (`apiKey`, `key` or `token`) is refused with a problem, and
  is never staged.
- **Without `base`** (a built-in provider): `keyEnv` and `models` are
  refused. A built-in provider authenticates the way opencode already does.
- `usageLimits.monthlyUsd` keys are `*` or a model id **without** the
  provider prefix. Values are positive numbers.

These checks need the catalogue, so they run in chain problems and in
`jinn doctor` rather than at load time:

- `base` is not in the catalogue on the gateway host;
- `provider` collides with a provider in the catalogue (only when `base` is
  set);
- a name in `models` is not one of the base's models;
- `keyEnv` is not set in the gateway's environment.

## Catalogue cloning

Discovery (`shared/opencode-discovery.ts`, `opencode-catalogue.ts`) keeps,
for every model of a provider that some account names as `base`:

- **2.x `api model.list`:** `package` and `settings.baseURL`. Every other
  `settings` field is dropped, `apiKey` included. It also keeps `limit`,
  `cost[0]` and `variants`.
- **1.x `models --verbose`:** `api.npm`, `api.url`, `limit`, `cost` and
  `variants`.

An account's models are the base's models, restricted to `models` when that
is set. Each one appears in the model registry (`GET /api/engines`, opencode)
as `<provider>/<model>`, with the base model's label, context window and
effort levels, and with `account: "<name>"` on the `ModelInfo`. Chain
validation, `modelNotServed`, the model pickers and the chain editor therefore
all see the account models with no further change. When the base is not in
the catalogue, the account has no models and the reason shows in chain
problems and `jinn doctor`.

## Staging

The per-session opencode config (`writeOpencodeSessionConfig`; the remote
`stageOpencodeConfig`; server mode's `spawnLocal` and `stageRemote`) gains one
`provider` block per declared account that has a `base`. An account on its
own is enough to stage a config, even with no MCP servers. The shape is the
same on 1.x and 2.x:

```json
{ "provider": { "opencode-go-b": {
    "name": "Go (second workspace)",
    "npm": "@ai-sdk/openai-compatible",
    "options": { "baseURL": "https://…/go/openai/v1", "apiKey": "{env:OPENCODE_GO_B_API_KEY}" },
    "models": {
      "deepseek-v4.1-flash": { "name": "…", "limit": {…}, "cost": {…}, "variants": {…} },
      "qwen3.7-plus": { "…": "…", "provider": { "npm": "@ai-sdk/anthropic", "api": "https://…/go/anthropic/v1" } } } } } }
```

- **The provider-level endpoint** is the endpoint the most base models use;
  on a tie, the openai-compatible one. A model on another endpoint or SDK
  carries a per-model `provider: {npm, api}`. A 2.x package name
  `@opencode/ai/providers/<sdk>` is written as `@ai-sdk/<sdk>`.
- **On a 1.x host**, by finding 5, a model whose endpoint differs from the
  provider-level one is left out of the block. When the local binary is 1.x the
  model registry leaves it out too, so a chain link to it is skipped as
  `model-not-served` and the pickers do not offer it. A turn whose own model is
  one of them (on the local binary or a remote host's facts) fails before
  opencode is launched, with `<model> is not served by account "<name>" on
  OpenCode 1.x (models on another endpoint need OpenCode 2)`. That error reads
  as model access (`opencode-failure.ts`): the turn, or the chain link, hops to
  the next link, and only `opencode/<provider>/<model>` is held, for the
  re-probe interval. `jinn doctor` reports such models for the local binary.
- **A session gets only the accounts its chain reaches.** An account's block and
  key are staged for a session only when its provider is the provider of the
  session's own model, of an opencode link in its resolved chain (the same
  resolution `sessionFallbackChain` gives, so its employee's, its account's or
  its engine's chain, or a stored per-session target; links the session can
  never walk, such as a department-scoped session's, count for nothing), or of
  the model the turn runs on. None reachable stages no account block and no
  key. On a server, the staged set is in the fingerprint, so a chain change
  that adds an account restarts the server at the next turn.
- **The gateway does not keep the key in its own environment.** At config
  load it moves each `keyEnv` value out of `process.env` into memory
  (`shared/child-env.ts`). No spawn site can then pass a key on by accident,
  whatever env it hands down. Only the opencode launch paths and the
  key-state readers read the value back, and the gateway's own successor
  (daemon start, restart) is given it. A reload that removes an account
  forgets its key.
- **opencode's MCP children do not inherit it.** opencode passes its whole
  environment to the MCP servers it launches. Every opencode process the
  gateway starts (run, serve, local and remote) carries `JINN_SCRUB_ENV`, the
  names of every declared `keyEnv`, and `mcp/scrub-entry.ts` and the jinn MCP
  `server-entry` delete those names and the list before launching or serving.
  Inherent: the session's own shell tool can read the key (opencode needs it),
  and `/proc/<gateway pid>/environ` shows the gateway's start environment to
  same-user processes, as for every gateway secret.
- **The key never appears in a staged file.** The file holds only
  `{env:<keyEnv>}`.
  - Local processes get `<keyEnv>` set explicitly on the child's env, from
    the value the gateway holds.
  - Remote `run` and `serve` processes get it through a 0600 `account-keys.sh`
    of its own, sourced after `session-env.sh`; the terminal view's
    `opencode attach` sources `session-env.sh` alone, so it holds no key.
    Never on the ssh command line.
  - An unset `keyEnv` stages the block anyway (the link then fails as auth
    and hops) and is reported by doctor and chain problems.
- **Server mode:** `serverFingerprint` includes each staged account's provider
  id, its model list, and a short sha256 of its resolved key, so that a key
  rotation or an account change restarts the warm server. The key itself is
  never part of the fingerprint.
- Model discovery itself never stages accounts. Account models come from
  cloning.

## Chain validation

`fallbackChainProblems` (shared with the web editor) checks an opencode link
`provider/model` whose provider is a declared account's provider:

- `model "<m>" is not served by account "<name>"` when the model is not among
  the account's models;
- `account "<name>" has no key: <keyEnv> is not set` (server side only, since
  the web has no environment).

An opencode link whose provider is neither an account nor in the catalogue
gives `provider "<p>" is not in opencode's catalogue or engines.opencode.accounts`
when the catalogue is known (non-empty). `jinn doctor` prints every chain
problem and every account problem above.

## Metering and health

- **Per account and model.** An account's `usageLimits.monthlyUsd` meters its
  models: an exact model key wins over `*`. An account without `usageLimits`
  inherits the engine-level `usageLimits.monthlyUsd` entries of its base
  (`<base>/<model>`, then `<base>/*`). Engine-level keys still meter any
  provider directly. Spend is already recorded as `provider/model`, so the
  ledger separates accounts as it is.
- **Exhaustion.** A fully spent window of any metered model records
  `opencode/<provider>` exhausted (stamped with the model) until the ledger
  says that window reopens. When several models or windows are spent, the
  latest reopening applies. The engine-wide `opencode` key is never written
  by the meter. The engine snapshot's top-level `windows` stays the default
  model's, for display only.
- **The provider's own refusal wins.** A refusal recorded by failure
  classification under the same key (quota, auth or model access) stays as
  recorded. The meter never clears or shortens it, because the ledger does
  not see the provider's own meter.
- **Subscription membership.** An account whose `base` is a subscription
  provider (or that declares one directly) counts as one for failure
  classification, through `isOpencodeSubscriptionProvider`. Its credential
  fingerprint is a short sha256 of the resolved key, through
  `opencodeCredentialFingerprint`.
- **New sessions.** When a new session's own opencode link is exhausted, it
  starts on the first healthy link of its chain, as for Claude accounts. An
  employee with no pinned model is keyed by the provider of
  `engines.opencode.model`; the session's model is not pinned by this.

## API

`GET /api/engine-limits` gains `accounts.opencode`, one entry per declared
account, built-in ones included:

```ts
interface OpencodeAccountLimitSnapshot extends EngineLimitAccountSnapshot {
  // account, label, location {kind:"local"}, employees: names whose own model is on this provider
  provider: string;
  base?: string;
  keyEnv?: string;          // the variable's name; never its value
  keySet?: boolean;         // with base: whether keyEnv is set in the gateway's environment
  buckets: EngineLimitBucket[];   // one per metered model: id "<provider>/<model>", windows 5h/7d/30d
  lastFailure?: { class: "quota" | "auth" | "model-access"; at: string; reason?: string };
  nextTryAt?: string;       // when health stops holding the provider: recheckAt, else until
  exhausted?: { until?: string };
  problems?: string[];      // the account's doctor problems
}
```

`accounts.opencode` is present whenever at least one account is declared;
`accounts.claude` is unchanged. A `jinn limits` card per account prints
the label, provider, key state, each bucket's windows, the last failure and
the next try. Claude accounts get the same treatment, which `jinn limits`
does not print today.

`GET /api/engines`: account models on the opencode entry, with `account` set
(see Catalogue cloning). `GET /api/config` shows `engines.opencode.accounts`
as written, `keyEnv` included (it is a variable name, not a secret).

## Web

- **Settings > Engines > opencode:** an Accounts list with each account's
  name, label, provider, base, key variable with set/unset (from the
  limits snapshot), model count and usage limits, plus the account's
  problems.
- **Chain editor:** an opencode link's model select offers account models.
  They come from the registry, grouped or badged by account label.
- **Limits page:** one card per opencode account, with a window row per
  metered model, the last failure class with its time, and "next try" when
  held.

## Docs

- `docs/engines-opencode.md`: an "Accounts" section (config, how a key is
  passed, 1.x limits, metering).
- `docs/fallback-chains.md`: opencode accounts in chains (links, health keys,
  hops keep the thread).
