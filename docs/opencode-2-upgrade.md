# Upgrading a host from opencode 1.x to OpenCode 2

This guide moves a host that runs Marid's opencode engine from opencode 1.x
(1.19.0 here) to OpenCode 2 (2.0.29 here; 2.0.28 is the oldest Marid's server
mode supports). It covers the gateway host and any remote host
(`remoteHost`) that runs opencode, on `linux-x64` and `linux-arm64`, and how
to go back to 1.x.

Each host can be upgraded on its own. Marid reads each binary's version and
drives it in the matching API, so a gateway on 2.x can run remote turns on a
host still on 1.x, and the other way round.

## What changes on 2.x

| | 1.x | 2.x |
|---|---|---|
| Server API | `/global/health`, `/event`, `/session/...` | `/api/*`. Marid detects this and switches. |
| Plugins | a `Plugin` factory export | `export default { id, setup }`. 1.x plugins fail to load (non-fatal). |
| `opencode-rate-limit@1.4.0` | works (but see [fallback chains](fallback-chains.md): the gateway reports it) | does not load. Model fallback is a gateway chain; run `jinn fallback migrate-opencode` (step 5). |
| Credentials | `~/.local/share/opencode/auth.json` | the SQLite DB. Imported automatically from `auth.json` the first time 2.x opens a 1.x data directory. |
| Sessions DB | `~/.local/share/opencode/opencode.db` | the same file, migrated in place on first start. Session ids are kept, so Marid resumes carry over. |
| `opencode.json(c)` | v1 keys | v1 keys still read and converted in memory; the file is not rewritten. |
| `opencode attach` | the terminal view | gone. Marid runs `opencode --server <url> -s <session>` instead. |
| `opencode run`, `models`, the TUI | private process | start and reuse a background service (`opencode service`, port 49374). Marid passes `--standalone`. |
| fff file indexer | on; Marid turns it off | still on by default, and `OPENCODE_DISABLE_FFF` is still honoured. |
| Built-in tools | `bash`, `task` | `shell`, `subagent`, plus `execute` (code mode) |

Marid needs no configuration change. `engines.opencode.bin`, `mode: server`,
`autoCompact`, `server.maxIdleByHost`, `disableFff` and the Claude engine's
opencode fallback all work on 2.x as they are.

## Before you start

- The gateway runs a Marid release with OpenCode 2 support, and every remote
  host has the same `jinn-cli` version (the usual remote requirement).
- `npm` on each host, to fetch the binary (step 3).
- `error-retry.js` from `examples/opencode-plugins/` at the release tag, if the
  host used the 1.x `error-retry.js`. The `jinn-cli` npm package does not ship
  `examples/`, so take it from a checkout of the repository at that tag, or
  download the file from it.
- Plan a restart. The gateway's opencode servers are stopped by it, and a
  remote host's opencode version is read when the gateway first reaches it,
  so `jinn restart` after upgrading a remote host makes the gateway see the
  new version at once. Without the restart, Marid notices the new version
  when it next starts a server there, and restages that server.

## Upgrade one host

Run these as the user that runs opencode on that host. `ARCH` is `x64` or
`arm64`. A host whose CPU lacks AVX2 needs the `x64-baseline` build.

1. **Stop what is using opencode.** Wait until no opencode turn is running,
   then stop the gateway (`jinn stop`, on the gateway host). On a remote host,
   check that no `opencode serve` is left: `pgrep -af "opencode serve"`.

2. **Back up the binary, config and data.**

   ```sh
   B=~/opencode-1x-backup        # the rollback below uses this same path
   mkdir -p "$B/dot-opencode"
   cp -p ~/.opencode/bin/opencode ~/.opencode/bin/opencode-1.19.0
   cp -a ~/.config/opencode "$B/config-opencode"
   cp -p ~/.opencode/*.json "$B/dot-opencode/"      # config only, not the binaries in bin/
   cp -p ~/.local/share/opencode/opencode.db* "$B/"
   cp -p ~/.local/share/opencode/auth.json "$B/"
   ```

3. **Install 2.x next to 1.x.** Do not use `opencode upgrade --major`: it
   overwrites `~/.opencode/bin/opencode` in place and keeps no copy.

   ```sh
   d=$(mktemp -d) && cd "$d"
   npm pack @opencode/cli-linux-ARCH@2.0.29
   tar xzf opencode-cli-linux-ARCH-2.0.29.tgz
   install -m 755 package/bin/opencode ~/.opencode/bin/opencode-2.0.29
   ~/.opencode/bin/opencode-2.0.29 --version      # opencode v2.0.29
   ln -sfn opencode-2.0.29 ~/.opencode/bin/opencode
   cd ~ && rm -rf "$d"
   ```

   `~/.opencode/bin/opencode`, which Marid's `engines.opencode.bin` and the
   `~/.local/bin/opencode` symlink point at, is now 2.x.

4. **Keep the file indexer off for hand use too.** Keep
   `export OPENCODE_DISABLE_FFF=1` in `~/.bashrc`. 2.x's background service
   does not take its environment from later shells, so also set it there
   once:

   ```sh
   opencode service set env OPENCODE_DISABLE_FFF 1
   ```

   `opencode service get` shows it under `env`. Marid's own processes get the
   variable from `engines.opencode.disableFff`, which defaults to on.

5. **Replace the plugins, and move model fallback to the gateway.** opencode
   no longer falls back between models by itself: model and provider hops are
   gateway [fallback chains](fallback-chains.md). First turn the host's
   fallback settings into a chain, on the gateway host:

   ```sh
   jinn fallback migrate-opencode            # prints the chain; --write adds it to config.yaml
   ```

   Then, on the host (from the directory holding `error-retry.js`):

   ```sh
   cp error-retry.js ~/.config/opencode/plugin/
   rm ~/.config/opencode/commands/rate-limit-status.md
   ```

   - The first command replaces the 1.x `error-retry.js`.
   - The `/rate-limit-status` command came from the fallback plugin, so the command file goes.
   - In `~/.config/opencode/opencode.jsonc`, remove `"opencode-rate-limit@1.4.0"` from `"plugin"`, and remove the key if nothing is left in it.
   - Leave `"model"` and `$schema` as they are.
   - Delete `~/.opencode/rate-limit-fallback.json` once `jinn fallback migrate-opencode` has been run. `jinn doctor` confirms no internal fallback is left.
   - The `@opencode-ai/plugin` pins in `~/.config/opencode/package.json` and `~/.opencode/package.json` are unused by 2.x. Leave them for a rollback.

6. **Check credentials and plugins.** The first 2.x command migrates the
   database and imports `auth.json`:

   ```sh
   opencode auth list                 # both providers listed as stored
   opencode plugin list               # lists opencode-error-retry
   opencode api GET /api/plugin       # their state; repeat once if the first answer is "data":[]
   opencode models --standalone | head
   ```

   `opencode plugin list` shows no state. In `/api/plugin` the plugin should be
   `"status":"active"`; the first call can answer `[]` while the plugins load.
   `auth list`, `api` and a bare `opencode` (the TUI) use 2.x's background
   service, start it if it is not running, and leave it running.
   `opencode service status` shows it, and `opencode service stop` stops it.

   If a provider is missing, sign in again with `opencode auth login`. On a
   host that never ran 1.x, `auth.json` is not imported, so log in there, or
   use `opencode auth export` and `opencode auth import` from a host that has
   the credentials.

7. **Restart Marid** on the gateway host: `jinn restart` (or `jinn start`
   after step 1's stop).

## Check it works

- **A turn.** Send an opencode employee on each host a message. The gateway
  log shows `opencode server ready` for that session, and the turn answers.
- **The jinn tools.** Ask the employee to call one, for example to read its
  Todo. A `MCP server(s) not connected` warning in the gateway log means the
  jinn MCP server did not start on that host.
- **The terminal view.** Open the opencode CLI view of that chat. It shows the
  session in OpenCode 2's TUI.
- **Hand use.** Run `opencode` in a terminal: the TUI starts with the same
  model and providers, and no "Plugin failed" toast.

## Roll back to 1.x

1. Stop the gateway (`jinn stop`), and stop 2.x's background service while
   the binary is still 2.x: `opencode service stop`. Set `B` to the backup
   directory from step 2 (`B=~/opencode-1x-backup`).
2. Point the binary back: `ln -sfn opencode-1.19.0 ~/.opencode/bin/opencode`.
3. Restore the 1.x plugin setup from the backup:

   ```sh
   cp -a "$B/config-opencode/." ~/.config/opencode/
   ```

   This puts back `opencode.jsonc`, `plugin/error-retry.js` and
   `commands/rate-limit-status.md`. The 2.x `error-retry.js` is replaced by
   the 1.x one from the backup, because 1.x loads every file in `plugin/`.
   The restored `opencode.jsonc` lists `opencode-rate-limit@1.4.0` again, which
   brings back an opencode internal fallback beside the gateway's chains
   (`jinn doctor` reports it). Leave it out of the restored `"plugin"` list
   unless that is what you want.
4. `jinn restart`.

1.19.0 opens the database that 2.x migrated, but each version keeps its own
copy of the sessions. That has three effects:

- **A session from before the upgrade resumes on 1.x without the turns added
  under 2.x.** Resuming does not fail, so Marid does not notice: the model
  just no longer sees those turns.
- **A session created under 2.x does not exist for 1.x.** Its next Marid turn
  starts a new opencode session with the chat's transcript, as for any lost
  conversation.
- **Upgrading again does not merge.** 2.x migrates a 1.x database only once.
  Turns and sessions added under 1.x after the rollback are not visible to
  2.x. An existing session resumes without them, and a session made under 1.x
  gets a new, empty session from 2.x. Credentials added under 1.x in that
  window need `opencode auth login` on 2.x.

So a rollback is for when 2.x does not work at all, and the sooner the
better. Restore the `opencode.db*` backup only if 1.x will not start: it puts
every session back to its state at the upgrade.
