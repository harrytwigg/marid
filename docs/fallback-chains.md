# Fallback chains

A fallback chain is an ordered list of **targets** a session moves through when
its own target cannot serve a turn. A target is an engine, optionally a Claude
profile, and optionally a model:

```yaml
engines:
  claude:
    accounts:
      work: { configDir: /home/operator/.claude-work }
    fallback:                         # the default Claude profile's chain
      - { engine: claude, profile: work, model: sonnet }
      - { engine: opencode, model: opencode-go/glm-5 }
      - { engine: opencode, model: openrouter/z-ai/glm-5 }
```

The gateway owns all fallback. Engines run without fallback of their own; in
particular opencode no longer switches models internally (see
[opencode](#opencode-internal-fallback-is-removed)).

The wire shapes, normalisation and validation sentences live in
`packages/jinn/src/shared/fallback-chain-wire.ts`, shared by the config loader
and the Settings editor.

## Config

### Where a chain is written

| Subject | Key | Applies to |
|---|---|---|
| Engine default | `engines.<engine>.fallback` | sessions on that engine (for Claude: the default profile) |
| Claude account | `engines.claude.accounts.<name>.fallback` | sessions on that declared profile |
| Employee | `fallback` in the employee's YAML | that employee's sessions; overrides the two above |

A session's chain is chosen in this order, first match wins:

1. the session's own fallback target (chosen from the fallback chip): a
   one-link chain, as before;
2. the employee's `fallback` (`fallback: []` means no fallback);
3. the session's account chain (`engines.claude.accounts.<name>.fallback`);
4. the engine default (`engines.<engine>.fallback`), for the default Claude
   profile and every other engine.

A local named profile that is not declared under `engines.claude.accounts`, and
whose employee writes no `fallback`, has no chain: it waits for its own reset,
as before.

### Entries

An entry is a mapping `{engine, profile?, model?}`:

- `engine`: any known engine.
- `profile`: a declared account name under `engines.claude.accounts`. Only
  Claude links take one. Absent means the default Claude profile.
- `model`: a model id the engine serves (opencode's `provider/model`). Absent
  means: on the same engine as the session, the session's own model; on
  another engine, the `fallbackModelMap` translation of the session's model if
  there is one, otherwise that engine's default.

The same engine may appear several times with another profile or model, so
`claude/A/opus -> claude/B/sonnet` and `opencode-go/x -> openrouter/x` are both
chains. Only an exact duplicate (same engine, profile and model) is a problem,
as is a link equal to the target the chain falls back from.

A save (`PUT /api/config`, the employee `PATCH`) refuses a duplicate. A config
that already repeats a target still loads, so an upgrade never stops a gateway
starting: the repeat is warned about at startup (naming the config path and the
target), the chain lists the target once, the chain's `problems` in
`GET /api/fallback-chains` and `jinn doctor` report it, and an unrelated save
leaves it untouched until that chain is edited. A link equal to the target the
chain falls back from, an unknown engine, an undeclared profile and a bad model
are still load errors; in an employee's YAML they drop that employee's chain
(it inherits) and are reported as `problems`.

### Legacy forms

The string forms keep working and keep their meaning:

- `codex` is that engine, followed by codex's own chain;
- `claude:<name>` is that declared account, followed by its own chain.

A chain is resolved to its **effective** chain by expanding each string entry
in place into the order the old walker visited it, skipping targets already in
the list. A chain written only in strings therefore runs exactly as before.
`fallbackModelMap` keeps working as the model rule for links without a model.
The Settings editor shows the effective chain; saving an edited legacy chain
writes it as explicit links.

## Runtime

### What moves a session along its chain

| Failure | Moves on from | Recorded in engine health |
|---|---|---|
| rate limit, quota, usage limit | any target | yes, on the failing target |
| engine gave up its own provider retries | any target | yes |
| model not served | a fallback link only | no |
| profile signed out | a fallback link only | the auth outage record, as today |

Other failures (network, terminal errors) end the turn as before. A turn on
the session's own target that hits a limit with no usable link waits for its
reset, as before.

### Walking

- A **run** starts at the session's first hop and ends when the session goes
  back to its own target. Within a run every target is tried at most once: the
  session's own target and every tried link are in the run's tried set, which
  is the loop guard. A chain can hop several times within one turn, up to its
  length: the turn runs on a link, and when that link fails in a way that moves
  on, the next link takes the same turn.
- The next link is the first one after the target the session stands on that
  has not been tried and is not ruled out. A chain is always the chain of the
  session's **own** target, whichever target is running now, so a limit on a
  stand-in continues along it and never goes back to the target the session left.
- A link is passed over (and named in the hop record) when it was already
  tried, its engine is not installed, its engine cannot run on the session's
  host, the session is department-scoped and the link is not a Claude account,
  or its model is not served. A link whose health says it is at its limit is
  passed over first, and tried only when nothing healthier is left.
- When the chain runs out, the session waits for its own target's reset and
  resumes there. It reads `waiting` (its `lastError` names the own target and
  when it reopens, e.g. "claude · work · opus usage limit, resumes …"), its last
  hop has no target, and the notice says plainly that no hop is left and what
  was tried. If a stand-in held the session when it ran out, the wait ends
  where the stand-in's window does (the own target's reset), and the turn runs
  again on the own target.
- At its own target's reset the session goes back to it and the run ends, as
  substitution reverts today. So does a manual engine switch, an API reset and a
  conversation the engine lost: the run ends, the hops stay.
- A **new** session whose own target is out of allowance starts on the first
  healthy link instead, with a run that starts there.

### Health keys

A Claude target's health is its account's. An opencode target's health is kept
per provider (`opencode/<provider>`), so a provider's usage limit does not mark
other providers' links as spent. Every other engine keeps one key.

### Context across a hop

Each account (and each non-Claude engine) keeps its own conversation thread.

- **Same thread, other model** (`claude/A/opus -> claude/A/sonnet`,
  `opencode-go/x -> openrouter/x`): the thread resumes with the new model.
- **Another account or engine with a thread of its own**: that thread resumes,
  with the messages it has not seen prepended (everything since the thread was
  last brought up to date: its slot's `lastSyncedAt`).
- **Another account or engine with no thread**: a fresh run whose prompt
  carries the recent conversation. A Claude session id from one profile is
  never resumed under another.
- **Back on the session's own target**: its thread resumes with the messages
  exchanged elsewhere prepended, as today.

### What is recorded

Each hop is recorded on the session (most recent 20) with its time, from and
to targets, reason, the failing target's reset and any links passed over, and
announced in the transcript as a notice: a `notification` message whose
`meta.fallbackHop` is the hop (`FallbackHopNoticeMeta`), which the dashboard
shows as a card with the links passed over. A chain that runs out records a
last hop with no target. The target that served the latest turn is recorded
too, for a session that has walked a chain. In `transportMeta`: `fallbackRun`
(`source`, `position`, `tried`, `startedAt`, present only while the session is
off its own target), `fallbackHops` and `fallbackServedBy`; the override record
names the stand-in as `substituteTarget {engine, profile?, model?}`. The
session API reports the chain, its position, the next hop and the hops under
`fallback.chain`.

## API

- `GET /api/fallback-chains`: declared profiles, plus every engine and account
  chain as written and as effective. Each link carries its limit state, its
  `written` form (what an editor writes back) and why it would be skipped.
  `?employee=<name>` adds that employee's chain, with the `source` it comes from.
  The route is the operator's: a department-scoped caller is refused.
- Engine and account chains are written through `PUT /api/config`; an
  employee's through `PATCH /api/org/employees/<name>` with `fallback` (a list,
  or `null` to inherit).
- `GET /api/sessions/<id>`: `fallback.chain` (`SessionFallbackChainView`): the
  links, the position, the next hop, the hops and `servedBy`. A
  department-scoped session reading its own session gets each link's `state`
  and `until`, but not `usedPercent` or `window`.

## opencode internal fallback is removed

opencode used to switch models on a usage limit by itself, through the
`opencode-rate-limit` plugin (1.x) or the example `model-fallback.js` plugin
(2.x), configured per host in `rate-limit-fallback.json`. That fallback was
invisible to the gateway, could not move a session to another engine or
profile, and could not be seen or edited in the dashboard. It is removed:

- opencode turns run with no internal fallback, and the adapter code that
  adopted a plugin's re-sent prompt is gone;
- opencode model and provider hops are chain links:
  `{engine: opencode, model: openrouter/x}`;
- a host still running a fallback plugin is reported by `jinn doctor`, at
  gateway start, and in Settings, so a double fallback is never silent.

### A configured plugin is reported, not neutralised

The gateway cannot switch an operator's fallback plugin off for its own
sessions alone, so it detects and reports one. Checked on the real binaries
(opencode 1.19.0 with `opencode-rate-limit@1.4.0`, and 2.0.29 with the example
`model-fallback.js`, against a provider answering 429):

| Lever | 1.19.0 | 2.0.29 |
|---|---|---|
| a staged `OPENCODE_CONFIG` with an empty plugin list | the plugin still switches models: plugin lists are concatenated, not replaced | the same |
| a staged plugin with the same name as the operator's | the plugin still switches models | not applicable: 2.x reads no local module path from config |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_DISABLE_PROJECT_CONFIG` | the plugin still switches models | no such variable |
| `OPENCODE_PURE=1` | stops the plugin, and every other external plugin with it: the operator's provider-auth plugins and the gateway's own staged plugin (the command-timeout cap) | no such variable |
| `OPENCODE_CONFIG_DIR` pointing elsewhere | not tried | replaces the operator's config directory, so the provider config goes too (`provider.no-route`) |
| the plugin's own `"enabled": false` | the plugin reads the first existing file of the project, `~` and the config directory (each under `.opencode/`, `opencode/`, then bare): the gateway would have to write into the operator's project or home | the same |

What a gateway turn does on a host that still has the plugin (real binaries, the
same 429 upstream, through the gateway's opencode engine; the default model's
provider answers 429 and the plugin's fallback provider answers normally):

| opencode | Mode | What happens |
|---|---|---|
| 1.19.0 + `opencode-rate-limit@1.4.0` | server | The plugin aborts the turn and re-sends the prompt as a new message, which the gateway no longer adopts. The turn ends in about 5 s as a usage limit (`rateLimit: rejected`) whose error names the plugin, so the chain takes over. The re-sent copy has usually reached the fallback model by then (one request); the gateway aborts it, and its answer is never delivered. |
| 1.19.0 + `opencode-rate-limit@1.4.0` | run | The plugin's abort ends the process with exit 0, no answer and no error of its own, before any re-send, so no request reaches the fallback model. The turn ends as a usage limit whose error names the plugin. |
| 2.0.29 + `model-fallback.js` | server | The plugin switches the session's model inside the turn. The fallback model answers it in about 3 s. No hop is recorded and the chain is not walked, but the turn says so: a warning in the gateway log and one session notice, "Answered by <provider/model> through the host's opencode fallback plugin, not the gateway's chain. Run `jinn doctor` to remove it." |
| 2.0.29 + `model-fallback.js` | run | The same answer from the fallback model, invisibly to the chain; the notice is posted only for a server turn, which sees which model each step ran on. |

**How a 1.x turn's outcome is decided on a plugin host.** The plugin's abort
carries no error, so the gateway reads it from evidence. Every condition below must
hold before a turn becomes the plugin's usage limit:

- the host has the plugin and the binary is 1.x. 2.x turns are never read this
  way, because the 2.x plugin switches models instead of aborting;
- the process exited 0, the transport did not fail, and the gateway did not stop
  the turn itself (an interrupt or a timeout keeps its own error);
- no error other than a usage limit was reported;
- the turn stopped while a model step was still due: no step finished, or the
  last one finished on a tool call. opencode only stops there when something
  aborts it. A turn the model ended itself closes on a `stop` step.

When all hold, any text the turn wrote came from a step that ended on a tool call.
That text is narration ("Let me read the file") and is not taken for the answer.
The turn ends as a usage limit, and its error names the plugin.

When any condition fails, the turn is read exactly as on a host without the plugin:
- a blank last step is a plain error, so it cannot mark the whole opencode
  engine as exhausted;
- a final step's text is the answer;
- a crash, transport failure or interrupt is never read as a usage limit.

The tests in `opencode-fallback-plugin-turn.test.ts` and
`opencode-server-provider.test.ts` pin each side of every condition. A change
here must keep both sides covered.
The 2.x notice is posted wherever the turn takes the engine's result: the first
attempt, a chain hop's substitute and a parked retry.

Before this was handled, a 1.x server turn also ended as a usage limit but left the copy running, and a 1.x run turn
ended with `opencode exited successfully without a final assistant response` and no rate limit, so the chain
never took over.

What is checked, and where:

- the plugin in a `plugin` or `plugins` list of the operator's opencode config
  (`opencode.json`, `opencode.jsonc` or `config.json` in the config directory
  and `~/.opencode/`, `OPENCODE_CONFIG`, and `opencode.json` and `.opencode/`
  in the directory the gateway (or `jinn doctor`) runs in, which stands for the
  project: a session's own working directory is not read);
- a `model-fallback` or `opencode-rate-limit` file or directory in a `plugin`
  or `plugins` directory of those;
- a `rate-limit-fallback.json` without `"enabled": false` in `.opencode/`,
  `opencode/` or the directory itself, under the project, `~` and
  `$XDG_CONFIG_HOME`: the places the plugin reads.

`GET /api/engines` carries the reading on the opencode entry:

```json
"internalFallback": { "detected": true, "neutralised": false, "sources": ["…/rate-limit-fallback.json"] }
```

`sources` are the operator's own paths: they are in `jinn doctor`'s output and
at debug level in the log, never in an info-level line. Nothing is ever
written to the operator's files.

A remote host is read best effort, through the facts the gateway already
collects when it first reaches the host: a shell probe for the same markers
(a `grep` for the plugin's name as a whole package or file name in the opencode
config files, so a comment that merely mentions it counts; the plugin files; a
settings file whose top-level `enabled` is not false, read as plain JSON, so a
file with comments, which the plugin itself cannot read either, is skipped).
Its findings are added to `sources` as `host: path`, and the first
one for a host logs the same warning. A project directory is not read on a
remote host, since the host does not know which project a session will run in.

### Migrating a host

1. Run `jinn fallback migrate-opencode` to print the chain equivalent of the
   host's `rate-limit-fallback.json` (`--write` adds it to the config).
   `fallbackModels: [a, b]` becomes
   `engines.opencode.fallback: [{engine: opencode, model: a}, {engine: opencode, model: b}]`;
   per-model lists become employee chains for the employees pinned to that
   model, and `"*"` the engine default.
2. Remove the plugin from the host's opencode config (`plugin` in
   `opencode.json`, or `model-fallback.js` from the plugin directory) and delete
   `rate-limit-fallback.json`.
3. `jinn doctor` confirms no internal fallback is left.

The plugin's `cooldownMs`, `circuitBreaker`, `fallbackMode`, `restoreModel`
and `retryPolicy` have no setting of their own: engine health, the
once-per-run rule (a chain's length bounds the hops) and the return to the
session's own target at its reset cover them. `jinn fallback migrate-opencode`
lists each such key it finds, with this reason. `--write` merges only the
engine default, and refuses when `engines.opencode.fallback` is already set. It goes through the atomic config save, so YAML comments in `config.yaml` are not kept, and an `engines.opencode` block is created when there is none.

## Testing without real providers

`scripts/verify-fallback-chains.sh` starts a throwaway gateway on its own port
with a temporary home, fake Claude profiles and stub `claude` and `opencode`
binaries that succeed, report a usage limit, stall or fail on command, per
profile and model, in the formats the gateway classifies. Its scenarios walk a
four-link chain hop by hop, run a chain out, and check the loop guard. No
provider is contacted. `scripts/verify-fallback-chains/README.md` says how to run it, keep the
instance up for screenshots, and add a scenario.
