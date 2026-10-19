# Fallback chains: fake-provider verification

`scripts/verify-fallback-chains.sh` brings up a throwaway gateway against fake providers and
drives the fallback chain scenarios through its real HTTP API. Testing a chain must never
spend real usage or quota, so only the upstream providers are fake: the gateway, config
loader, runner and web are the real ones.

```sh
scripts/verify-fallback-chains.sh                    # build, then every scenario in opencode run mode and server mode
scripts/verify-fallback-chains.sh --skip-build       # reuse the existing build
scripts/verify-fallback-chains.sh --only a,f         # some scenarios
scripts/verify-fallback-chains.sh --mode server      # one opencode mode
```

Put the pinned Node first on `PATH` (or set `JINN_VERIFY_NODE_BIN`), as for the other verify
scripts. Exit status is 0 unless a scenario that is not pending fails.

## What is real and what is fake

| | |
|---|---|
| Real | the gateway build, its config loader and `PUT /api/config`, the interactive Claude engine (PTY, `--settings` hooks, transcripts), the opencode adapter in `run` and `server` mode, the chain runtime, the web app |
| Fake | `claude` (`scripts/fake-providers/fake-claude.mjs`) and `opencode` (`packages/jinn/src/engines/__tests__/fixtures/fake-opencode.mjs`), both steered by one scenario file and both appending to one ledger |

The instance runs under `env -i` with a temporary `JINN_HOME`, `HOME` and XDG directories, two
fake Claude profile directories (`profile-a`, `profile-b`) declared under
`engines.claude.accounts`, the stubs as absolute `engines.<engine>.bin`, no codex, grok or
hermes, and the browser MCP server switched off (it is an `npx` fetch). `npx` and `npm` are
stubs that do nothing, and `JINN_CLAUDE_USAGE_API=off` stops the usage lookup that would send
a token to the real service. A guard preloaded into every Node process refuses, and logs to
`network-refusals.jsonl`, any connection that is not loopback; a scenario fails if the log is
not empty.

The script refuses to start when the port is below 8060 or one of the live gateway ports, or
when any path (instance home, host home, profile directory) is outside its temporary root or
inside an operator home. It tears everything down on exit.

## Scenarios

`scenario-defs.mjs`, each printing `PASS`, `FAIL` or `PENDING`:

| id | |
|---|---|
| a | claude/A/opus → claude/B/sonnet → opencode/X → opencode/Y walks hop by hop; each hop's profile directory and model, the recorded hops and `servedBy` |
| b | every link limited: each target tried once, then the session waits on its own target |
| c | loop guard: legacy entries that form a cycle never retry a target |
| d | an employee chain overrides the engine default |
| e | a legacy string-only config behaves as on main |
| f | `PUT /api/config` refuses a duplicate target (and a link equal to its own target) with the clear sentence |
| g | a profile hop starts a fresh run carrying the conversation, with no `--resume` of A's session id under B; a model hop on the same thread resumes it |
| h | an opencode provider hop X → Y within one opencode session |

`--pending a,b,c,d,g,h` (the default) marks the scenarios that wait on runtime work not yet
merged. A pending scenario is reported, never failed; one that passes is reported as
"pending but passing", and `--strict` fails the run on it. Drop an id from the default list in
`verify-fallback-chains.sh` when its work lands. Run `--pending ""` to see every scenario's real
result.

To check the gateway of another checkout against this harness's fakes and scenarios (for
instance `main`, to confirm scenario e passes there too), set `JINN_VERIFY_GATEWAY_REPO`.

## The ledger proves who served each hop

Every turn a fake takes is a line in the ledger (`$VERIFY_ROOT/ledger.jsonl`; `--retain DIR`
copies it out): time, engine, profile directory and label, model, the `--resume` id it was
given, the conversation id it ran in, the start of the prompt, the message marks it carried,
the outcome and the scenario key that gave it. Scenarios read it back by the tag their prompts
carry (`fc-tag-…`), so the walk is checked against what the providers actually ran, not
against what the gateway says it did.

## Scenario file

`FAKE_PROVIDER_SCENARIO=<path>` maps invocations to outcomes (the driver rewrites it per
scenario; the fakes read it on every invocation):

```json
{
  "claude":   { "profile-a|opus": ["rate-limit", "ok"], "profile-b|*": "ok", "*": { "outcome": "rate-limit", "resetsAt": 4102444800 } },
  "opencode": { "x-provider/model-x": "rate-limit", "*": "ok" }
}
```

Claude keys are `<profile>|<model>`: the base name of `CLAUDE_CONFIG_DIR` (`default` for the
gateway's own profile) and `--model`. Opencode keys are `provider/model`, from `-m` on a run
turn or the model in the prompt body on a server turn. The exact key wins, then
`<profile>|*`, `*|<model>`, `*`. A list is a sequence: the nth invocation of a key takes the nth
item and the last repeats.

| outcome | claude | opencode |
|---|---|---|
| `ok` | answers, naming profile and model | answers, naming model and mode |
| `rate-limit` | statusline with the reset (`resetsAt`, epoch seconds, default one hour), then `StopFailure` with `error: "rate_limit"` | the 1.x limit error (`"form": "v2"` for 2.x's); in server mode the provider's retries, then the error |
| `retry-abandon` | | a retry an hour off, which server mode abandons after about 15 s as a rate limit |
| `hang` | never stops | never answers |
| `fail` | `StopFailure` (`max_output_tokens`, or `"error"`) | an error that is not a limit |
| `signed-out` | `StopFailure` `authentication_failed` | as `fail` |

While a scenario file is set, a prompt's own words steer nothing, so the older `HANG`,
`FAIL`, `PROVIDER…` directives in the opencode fixture stay available to the engine tests and
are off here.

The fake Claude files its transcripts under the profile's `projects/` directory, refuses to
resume a conversation another profile owns, and checks the profile's `.credentials.json`.
Its credentials hold no token, so nothing can use them.

## Keeping the instance up for screenshots

```sh
scripts/verify-fallback-chains.sh --skip-build --mode run --only a --keep --retain ./evidence > run.log 2>&1
```

`--keep` leaves the last instance running and prints its URL, home (the token is
`gateway.json` there) and the teardown command; redirect its output to a file, as above, or a
caller waiting on the pipe waits on the gateway. Drive a browser at it (headless Firefox, or
Chromium), then:

```sh
scripts/verify-fallback-chains.sh --teardown <verification root>
```

`--retain DIR` collects the ledger, the network log, each mode's results JSON and the gateway
logs.

## Adding a scenario

1. Append `{ id, title, run }` to `SCENARIOS` in `scenario-defs.mjs`. `run(h)` gets the harness
   (`lib.mjs`): `h.putConfig(...)` writes config through the real API, `h.writeScenario(...)`
   scripts the fakes, `h.startSession({ employee, tag })` and `h.settled(id)` drive a session,
   `h.rowsFor(tag)` reads the ledger, and `expectEqual` / `expectTrue` assert. The seeded
   employees and models are in `seed.mjs` (`h.layout`).
2. Reset is automatic before each scenario (sessions, engine health, chains, scenario file).
3. If it needs runtime work that is not merged, add its id to `--pending` in the script's
   default.
4. A new outcome or key shape goes in `scripts/fake-providers/scenario.mjs` and is covered by
   `packages/jinn/src/engines/__tests__/fake-providers.test.ts`.
