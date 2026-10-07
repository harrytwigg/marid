# Remote (SSH) execution

By default every employee's session is spawned on the machine running the
gateway — Claude Code as a real interactive TUI, Pi as a headless JSON run. An
employee that declares a `remoteHost` is spawned through `ssh` on another machine
instead, and everything it does — repository checkouts, builds, tests — happens
there.

Three engines can do this: **`claude`**, **`pi`** and **`opencode`**. Every other engine ignores
`remoteHost`, and a remote employee configured with one has its turns refused
rather than silently run on the gateway.

The motivating case is a gateway on a small always-on box (a Raspberry Pi, a
NAS, a cheap VPS) driving a powerful desktop that does the actual work. No
repository is ever cloned onto the gateway.

This is **opt-in per employee** and fails closed: without a `remote` block in
`config.yaml`, an employee naming a `remoteHost` refuses to load and says why.

## What a remote employee keeps

A remote employee is a full employee, not a degraded one:

| | Where it runs |
|---|---|
| Todos, Notes, work items, delegation, knowledge reads | The gateway, via the built-in `jinn` MCP server over the tunnel |
| Skills, `docs/`, `knowledge/`, `org/`, `secrets/` | The gateway, via the mounted instance home |
| Hooks (turn completion, tool events, safety prompts) | Delivered to the gateway over the reverse tunnel |
| The dashboard's live terminal view | Attached to the remote PTY (`claude`; Pi has no terminal view anywhere) |
| Repository code, builds, tests, scratch files | The remote host — the point of the feature |

The one deliberate omission is **live token-by-token streaming**, and it applies
to `claude` only: a remote Claude session runs without the per-PTY SSE proxy, so
the chat pane fills in when the turn ends rather than as it goes. Turn results,
hook-driven tool activity, and blocked-on-a-question notifications are
unaffected. A remote Pi session loses nothing here — its events come back over
the same stdout stream a local one reads, so streaming works exactly as it does
locally.

## Prerequisites on the remote host

1. **The agent CLI the employee's engine runs**, and only that one — a host that
   runs Pi employees needs no Claude Code, and vice versa.
   - `claude`: **Claude Code**, installed and signed in on the same plan the
     gateway uses. If the host uses a profile manager, see *Choosing a Claude
     Code profile* below — do not point Jinn at the wrapper script.
   - `pi`: **the Pi CLI**, with its providers configured in that host's
     `~/.pi/agent/models.json`. See *Running Pi remotely* below.
   - `opencode`: **the opencode CLI**, signed in there with
     `opencode auth login`. See *Running opencode remotely* below.
2. **Node.js**. Note the PATH caveat below — this is the single most likely
   thing to bite you.
3. **`jinn-cli` at the gateway's exact version**, installed globally:
   `npm install -g jinn-cli@<version>`. It is never started as a daemon there —
   it supplies the MCP server entrypoints, which are absolute paths that must
   exist on that machine. A version mismatch is refused at spawn with the
   command that fixes it.
4. **The gateway's instance home, sshfs-mounted.** For example:
   ```
   sshfs gateway-host:/home/<gateway-user>/.jinn /mnt/jinn-home -o reconnect,ServerAliveInterval=15
   ```
   Mount it from `/etc/fstab` or a systemd automount so it survives a reboot,
   and set `remote.remountCommand` so the gateway can re-establish it after a
   wake.
### The non-interactive PATH caveat

Sessions reach the remote host over a non-interactive `ssh` command, which reads
**no** shell rc file. A host whose Node comes from a version manager (nvm, fnm,
asdf) therefore looks like it has no `node` at all:

```
ssh build-box 'command -v node'     # prints nothing
ssh build-box                        # ...but node works fine once logged in
```

This matters twice over. The obvious half is that the preflight cannot find
`node` or `jinn`. The dangerous half is that Claude Code invokes **every hook**
as bare `node`, so without a resolvable `node` no hook could start — no `Stop`
would ever arrive and the turn would hang forever with nothing reported.

Jinn resolves nvm's layout directly rather than sourcing `nvm.sh` (which is
bash-only, and `/bin/sh` is `dash` on Debian-family systems including Raspberry
Pi OS), honouring nvm's `default` alias — a global `jinn-cli` lives under one
version's tree, so taking the newest version instead would report jinn missing
on a host where it is installed perfectly well. The resolved directory is then
prepended to the session's PATH so the hook relay runs.

If your host uses something Jinn cannot resolve, the fix is one symlink onto the
default PATH:

```bash
ln -s "$(command -v node)" ~/.local/bin/node
```

Verify with `ssh <host> 'command -v node jinn'`, plus `claude`, `pi` or
`opencode` for the engine that employee runs — each must print. `pi` needs this
as much as Claude Code does: it is an npm-installed CLI, so its shebang resolves
`node` through PATH, and a version-managed host gives a non-interactive ssh
none.

5. **Key-only SSH from the gateway.** Sessions run with `BatchMode=yes`, so a
   passphrase-locked key with no agent will simply fail. The host key must
   already be in the gateway's `known_hosts` — Jinn will not accept a new host
   key on your behalf.

## Configuration

In `config.yaml`:

```yaml
remote:
  # Every remoteCwd must resolve under this prefix on the remote host.
  root: /srv/jinn-work
  # Where the gateway's own instance home is sshfs-mounted over there.
  mount: /mnt/jinn-home
  # Optional. Bring a sleeping host up. wakeCommand wins over wakeMac.
  wakeMac: "aa:bb:cc:dd:ee:ff"
  # wakeCommand: "smartplug on workstation"
  # Run on the remote once it is reachable, to bring the mount back after a boot.
  remountCommand: "systemctl --user start jinn-home.mount"
  # Which Claude Code profile remote sessions run as. Omit for the remote
  # user's default. An employee's remoteClaudeConfigDir overrides it.
  claudeConfigDir: /home/<user>/.claude-profiles/personal
  # How long wakeCommand may run before it is killed. Default 300000 (5 min).
  wakeTimeoutMs: 300000
  # Bound on waiting for an unreachable host. Default 240000 (4 minutes).
  waitMs: 300000
```

In the employee's YAML under `<instance home>/org/<department>/<name>.yaml`:

```yaml
name: builder
displayName: Builder
department: engineering
rank: senior
engine: claude
model: opus
remoteHost: build-box
remoteUser: jinn
remoteCwd: /srv/jinn-work/main
persona: |
  You are Builder. You work on the main repository checked out at your
  working directory. Build and test there; record findings as Notes.
```

These three fields are YAML-only on purpose — they are **not** editable through
the employee-edit API. Being able to repoint where an unattended
`--dangerously-skip-permissions` session executes is not a dashboard-sized
decision.

## Choosing a Claude Code profile

If the remote host keeps several Claude Code profiles (a personal one and a work
one, say), name the one a session should use:

```yaml
remote:
  claudeConfigDir: /home/<user>/.claude-profiles/personal
```

An employee can override it, because which profile to use is a property of the
employee rather than the machine:

```yaml
remoteClaudeConfigDir: /home/<user>/.claude-profiles/alt
```

The profile reaches every remote launch: ordinary turns, auto-compaction, the
rate-limit retry and the dashboard terminal. A local employee names its profile
with `claudeConfigDir` instead (see the shipped `docs/org.md`, "Claude
profiles"). The two fields cannot be combined on one employee.

**Do not point Jinn at a profile-manager wrapper instead.** Those wrappers set
`CLAUDE_CONFIG_DIR` and then `unset` every `CLAUDE_*` and `ANTHROPIC_*` variable
before exec. That strips the three a session depends on — and losing
`CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` lets the "resume from summary?" picker
appear in front of a PTY with nobody at the keyboard, which hangs the turn. Jinn
sets the variable itself and runs the plain binary, getting the profile without
the collateral damage.

Four consequences follow, all handled for you:

- **The folder-trust seed runs under the same profile.** Claude Code keeps
  `.claude.json` *inside* `CLAUDE_CONFIG_DIR`, so seeding without it writes
  `~/.claude.json` while the session reads `<profile>/.claude.json` — the trust
  dialog would still appear and the first turn would hang. The seed cache is
  keyed on the profile too, so switching profiles re-seeds rather than assuming
  the old seed still counts.
- **An unsigned-in profile is refused up front.** A profile directory with no
  `.credentials.json` makes `claude` open a login prompt nothing can answer, so
  the spawn is refused with that reason instead of hanging.
- **Bypass-permissions consent travels, or the turn is refused.** Every session
  runs with `--dangerously-skip-permissions`, which Claude Code answers with a
  one-time consent dialog on a profile that has never accepted it. When the
  gateway's own Claude `settings.json` sets `skipDangerousModePermissionPrompt:
  true`, that consent is copied into the session's staged `--settings`, as it is
  for a local named profile. Otherwise the host must hold it where Claude Code
  looks for it: `skipDangerousModePermissionPrompt: true` in
  `<profile>/settings.json`, in `.claude/settings.local.json` (at the session
  directory or its git root, as Claude Code reads it), in the host's managed settings
  (`/etc/claude-code/managed-settings.json` or a drop-in under
  `managed-settings.d/`), or `bypassPermissionsModeAccepted` in
  `<profile>/.claude.json` from accepting the dialog once. A profile with none of
  these is refused before the spawn with the setting to add. Managed settings a
  claude.ai organisation delivers over the network, or a macOS MDM profile
  (`com.anthropic.claudecode`), are not in those files, so a profile relying on
  those alone is refused too: add the setting to its `settings.json`.
- **Your `attribution` travels; your `PreToolUse` hooks do not.** A local
  named profile gets three of the gateway's own Claude settings in its
  `--settings`. A remote one gets two: `attribution` (so commits and PRs carry
  no Co-Authored-By trailer or "Generated with" line unless you ask for them)
  and the consent above. `hooks.PreToolUse` stays behind on purpose. Its
  commands name files on the gateway's host, and Claude Code treats a hook that
  cannot run (exit 127, command not found) as a non-blocking error, so a carried
  guard would fail open on every call while looking like protection. A guard
  you want on the remote belongs in that profile's own `settings.json` on the
  host, with a command that exists there; the profile's own hooks run alongside
  the gateway's relay. The remote user's default profile gets none of these: it
  runs on that user's own settings.

When no profile is configured, `CLAUDE_CONFIG_DIR` is actively *unset* for the
session, so a stray value in the remote environment cannot silently choose the
credentials and trust state a session runs with.

`jinn remote status` prints the resolved profile per employee. None of this
applies to a Pi employee: Pi has no profile of its own to be signed out of, so
the profile checks are skipped for it rather than refusing a host over a Claude
Code install it never touches.

### The remote login is its own account

Each remote host, user and profile is its own Claude account
(`claude@<user>@<host>`, or `claude@<host>` with no `remoteUser`, plus `:<key>`
when a profile is named; see the shipped `docs/org.md`, "Claude accounts"). Its
usage limit and engine health are recorded under that key, so a spent operator
account does not move remote sessions and a spent remote login holds back only
its own.

The Limits page reads it over SSH on the same refresh as the local accounts,
**only while the host answers**: a host that is asleep is never woken to be read,
and its card shows the last reading and its age. The reading runs a small script
with the host's own Node. The script reads the login where Claude Code keeps it
for that profile (on a macOS host, the Keychain item named for the path; else
`<profile>/.credentials.json`, or `~/.claude/.credentials.json` with no profile)
and prints only the access token and its expiry, so the refresh token never
crosses the network. The profile path is an argument, never part of the script.
The gateway uses the token for one usage call, in memory, and drops it: it is
never stored, logged, refreshed or put in an environment. The plan comes from
`claude auth status` under the profile's `CLAUDE_CONFIG_DIR`. An expired token, or
a locked Keychain on a macOS host, reads as "no live reading". The rate-limit
backoff for a remote session takes its reset time from that account's last
reading.

## Running Pi remotely

Pi is the second engine that can be relocated, and the motivating case is the
mirror image of the gateway's: the desktop has the GPU and the local models, and
the Raspberry Pi orchestrating it has neither.

```yaml
name: hound
displayName: Hound
department: engineering
engine: pi
model: ollama/gemma4:12b   # the provider/id the REMOTE host serves
remoteHost: build-box
remoteUser: jinn
remoteCwd: /srv/jinn-work/main
```

The model id names a provider configured on the **remote** host's
`~/.pi/agent/models.json` — that machine is the one running the inference, so it
is the one whose providers matter. The gateway never assumes Ollama or any
specific backend.

The transport is the same `ssh` one Claude sessions use, and Pi rides it well:
its protocol is a prompt on stdin and newline-delimited JSON on stdout, and both
halves cross the connection untouched. Three differences from a remote Claude
session, all of them consequences of Pi being a batch engine rather than a TUI:

- **No remote pseudo-terminal.** The session is spawned with `ssh -T`, not
  `-tt`, so the remote process's stderr stays a separate stream instead of being
  folded into the JSON the engine parses.
- **No hooks, and no folder-trust seed.** Pi reports its result on the same
  stream it reports everything else, so nothing has to come back out of band —
  and it has no first-run dialog to pre-empt. The reverse tunnel is still opened,
  because the company toolset needs it (below).
- **The company toolset arrives as a generated extension, not an
  `--mcp-config`.** Pi loads the built-in `jinn` server as a module running
  in-process, and that module's imports are absolute paths. The remote copy is
  regenerated against the remote install's own `jinn-cli` — which is why the
  version match is enforced there too — and reaches the gateway over the same
  reverse tunnel. The bearer *and* this session's capability are staged into a
  0600 file the remote command sources, never put on the command line, which is
  readable by every process on that host.

One asymmetry worth stating plainly. A remote Claude session has
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` stripped
from the remote login environment, because an inherited key there would silently
move a subscription session onto metered API billing. **A remote Pi session does
not strip them**, and that is deliberate: Pi has no subscription auth to fall off
— it drives whatever provider the operator configured, and for an `anthropic`
provider an inherited key is how it works at all. What a Pi session does strip is
exactly what a local one strips: the markers that tell a nested CLI it is running
inside another agent.

## Running opencode remotely

opencode is the third relocatable engine, and it rides the transport the same
way Pi does — a prompt on stdin, newline-delimited JSON on stdout, `ssh -T` so
the remote stderr is not folded into that stream.

```yaml
name: scout
displayName: Scout
department: engineering
engine: opencode
model: anthropic/claude-sonnet-5   # opencode's provider/model, as that host resolves it
remoteHost: build-box
remoteUser: jinn
remoteCwd: /srv/jinn-work/main
```

The login that matters is the **remote** one: `opencode auth login` on that
machine. The gateway never reads it, and never refuses a turn over it — the same
rule that exempts remote employees from the Claude auth preflight.

Two things are staged, and one deliberately is not:

- **The company toolset is an `OPENCODE_CONFIG` file**, which makes this the
  simplest of the three wirings: opencode reads a real MCP config, so the
  session's resolved server set is re-pointed at the remote install exactly as
  Claude's is and written as opencode's own `mcp` block. Mode 0600, because the
  projected `environment` carries this session's capability. The bearer still
  comes from `<JINN_HOME>/gateway.json` over the reverse tunnel.
- **`OPENCODE_DISABLE_AUTOUPDATE=1`**, so a self-upgrade between two turns of one
  session cannot swap the binary under a conversation opencode is still holding.
- **Nothing relocates opencode's data directory.** There is no opencode
  equivalent of Pi's staged `--session-dir`, and that is on purpose: opencode's
  session store and its `auth.json` live side by side under the remote user's
  home, so moving the store would take the login with it and every turn would
  start unauthenticated. opencode generates its own session ids, so concurrent
  sessions in that one store cannot collide the way Pi's would.

The `ANTHROPIC_*` asymmetry described for Pi above applies to opencode for the
same reason, and a little more broadly: opencode reads provider keys for many
providers, and none of them are stripped from the remote login environment. It
has no subscription auth to fall off, and for a key-authenticated provider an
inherited key is how it works at all.

## Interrupting a remote Pi or opencode turn

Killing the local `ssh` client is not enough for these two engines, and the
gateway no longer pretends it is. A Claude session runs on `ssh -tt`, so when
its client dies the remote pty hangs up and `claude` gets SIGHUP. Pi and
opencode run on `ssh -T` — no tty, because a tty would fold their stderr into
the JSON stream — and sshd does not signal a no-tty command when its channel
closes: the process's pipes go dead, and one that ignores EPIPE simply carries
on. opencode does. On a real host an interrupted remote opencode ran for
eighteen minutes past its "kill" and committed into the worktree that its
successor had already been resumed on.

So a batch turn's remote command records the agent's pid and start time
before `exec` — `printf '%s\n%s\n' "$$" "$(ps -o lstart= -p $$)" >
<session home>/tmp/engine.pid`, where `exec` hands that same pid (and start
time) to the agent — and an interrupt, a turn timeout or a gateway shutdown
runs a control `ssh` that terminates the recorded process **and every
descendant it still has**, before the local client is signalled. The
descendants matter: opencode starts each bash-tool command in a session of its
own, so a `pnpm test` it launched is reachable only by walking the tree.
SIGTERM first, SIGKILL after a five-second grace. Before anything is signalled
the pid is checked against the recorded start time and, failing that, against
the agent's binary in argv — either alone has a hole (a shim exec's `node`, a
clock step moves every start time) — so a recycled pid is left alone; the
file is removed once the process it named is known to be gone.

The order is the point. The turn settles when the local client closes, and the
session queue starts the next turn on that settle. Killing the remote agent
first means the channel closes because the agent **exited**; the settle then
waits for the kill to report — the descendant sweep is still running when the
channel closes — so the next turn cannot start beside a process that is still
editing the same worktree. If the host cannot be reached, the client is killed
anyway and `gateway.log` warns that the remote process may still be running.
Two edges get a second look: an interrupt that lands while the turn is still
connecting, before the pid is recorded, finds nothing to kill — so when the
client then closes on the gateway's own signal the kill runs once more; and a
client that drops on its own (ssh exit 255, a network blip) has the remote
agent killed before the turn is allowed to settle.

One more guard covers a gateway that died without shutting down. `jinn
restart` kills live turns on the way out, but a crash does not, and the
restart-resume path would then start a fresh turn beside the survivor. So every
remote batch turn first reaps whatever the session's pid file still names —
turns are serialised per session, so a live process there can only be one that
outlived its gateway turn. Usually a single cheap control connection answering
`already-gone`; when it finds something, `gateway.log` says so.

## Pi or opencode as the fallback when Claude hits its limit

An engine's `fallback` chain works for remote employees, with one rule: a
substitute must be an engine that can follow the session onto its host.

```yaml
engines:
  pi:
    # The default a substituted turn runs on, and — on a gateway with no Pi CLI
    # of its own — the only model id the registry knows pi serves.
    model: ollama/gemma4:12b
  claude:
    fallback: [pi]
    # Optional, and usually unnecessary: which model survives the swap. Without
    # a mapping the pin is simply dropped and pi runs on `engines.pi.model`,
    # which is the right answer nearly always — a model id belongs to exactly
    # one provider, so carrying an Anthropic pin across is how a swap ends in
    # `model_not_found`. A target the registry does not list for pi is refused
    # with a warning and falls back to the same default.
    fallbackModelMap:
      opus: ollama/gemma4:12b
```

With that, a remote Claude employee that hits an Anthropic usage limit hands the
turn to Pi **on the same desktop**, against a model that machine serves locally,
and carries on. Without it — or with a chain naming an engine that cannot go
remote — the turn waits the limit out on the host that already owns the work,
which is what it did before.

Four things this gets right that are easy to get wrong:

- **The substitute is told where to run.** A rate limit is the one moment a turn
  is respawned rather than resumed, so the remote target — host, user, working
  directory *and* Claude profile — is restated; otherwise the fallback turn would
  quietly come back on the gateway, or come back under the wrong profile.
- **Each engine stages its own `$JINN_HOME` on the remote host**, under
  `~/.jinn-remote-stage/sessions/<session>__<engine>`. The substituted-from
  engine's session is not torn down — a remote Claude PTY stays warm and takes
  its next turn through the same connection — and its hook relay re-reads
  `gateway.json` on every hook. A shared directory would have the substitute's
  staging repoint that relay at a tunnel which dies with the substitute.
- **A substitute that cannot start is reported, not swallowed.** The session's
  engine has already been flipped by the time it runs, which is enough to make a
  thrown spawn look stale to the turn runner and be dropped — leaving the session
  at `running` with nothing said. It is caught where the flip happened and
  settled as a failed fallback carrying the real reason.
- **Availability is asked of the remote host, not the gateway.** A Raspberry Pi
  orchestrator has no `pi` CLI on it and does not need one. The check reads what
  the last spawn learned about the remote host's PATH; a host that has never been
  probed is treated as unknown rather than as empty, so the substitution proceeds
  and a genuinely missing binary is reported by the spawn, with the PATH
  diagnosis this layer cannot give.

## Where the company's rules come from

A local employee reads `CLAUDE.md` for free: its working directory *is* the
gateway's instance home, so Claude Code finds it there. A remote session's
working directory is the workspace instead, so the rules would simply be absent.

Jinn links them in: on every spawn, `<remoteCwd>/CLAUDE.md` becomes a symlink to
the mounted `CLAUDE.md`. Two guards, because this writes into a directory the
operator owns:

- **Never over a real file.** An existing `CLAUDE.md` — a repo's own, or one you
  wrote — is left exactly as it is.
- **Never inside a git working tree.** A directory containing `.git` is skipped
  entirely. An untracked file dropped into a checkout would show up in
  `git status` and be deleted by `git clean -fdx`.

Both cases are logged rather than passed over silently. A department-scoped
employee gets none of this (see "Department-scoped employees" below).

This is why **`remoteCwd` should be a workspace root, not a checkout**: point it
at a directory that holds repositories in subfolders. The rules then sit beside
them at the workspace root, where every repo can see them and none of them owns
the file.

```
/srv/jinn-work/main/          <- remoteCwd
  CLAUDE.md                   <- linked to the gateway's, never in a repo
  some-service/               <- cloned here
  another-repo/               <- and here
```

## Department-scoped employees

An employee in a `scoped` or `dedicated` department (see the instance's
`docs/org.md`) is staged differently, because the farm and the linked
`CLAUDE.md` above would hand it the whole company home:

- **Its working directory is its department's stage directory on the host**,
  `<remote.root>/.jinn-departments/<slug>/`: the department's generated
  `CLAUDE.md` and the skills it allows, the same content as the local stage
  directory. Before every scoped spawn the gateway sends the file set as a tar
  stream over ssh into `.jinn-departments/.<slug>.incoming-<random>/` and a
  script applies it file by file: changed files are renamed over the old ones,
  directories are made and never renamed over one that exists, extras go, and
  incoming directories older than an hour are reaped. The directory itself is
  never replaced, so its path (which the transcript slug and the trust key come
  from) stays put. The path is not keyed by instance, unlike the local stage
  directory: `remote.root` is the instance's own on a host, so two instances that
  share a host need different `remote.root` values. Nothing is cached, so a wiped or edited copy is restored by
  the next spawn. The sync runs inside the per-host lock, after the session's
  home and the assets and before the folder-trust seed.
- **Its instance home links nothing.** A variant of the farm script makes the
  home with `gateway.json`, `tmp/` and the stage marker only, keeps the reaping,
  the lock and the asset report, and removes any link a farm rebuild left there.
  No `CLAUDE.md` is linked anywhere. `FARM_SCRIPT` itself is unchanged.
- **Nothing above it is read.** Claude Code loads `CLAUDE.md`, `CLAUDE.local.md`
  and `.claude/` instructions from every directory above its cwd, and an
  unscoped colleague whose `remoteCwd` is `remote.root` has the company
  `CLAUDE.md` linked there. The scoped session's settings list every such path
  above the stage directory, as configured and as the host resolves it, in
  `claudeMdExcludes`. A scoped spawn is refused on a host whose `claude --version`
  is older than 2.1.288, the oldest build verified to honour it (asked once per
  host and binary), and when the sync does not report the real path. The
  exclusions cover every directory above the stage directory, so with no
  Claude profile configured and `remote.root` under the remote user's home, that
  user's `~/.claude/CLAUDE.md` and `~/.claude/rules/` are skipped as well; a
  profile's own `CLAUDE.md` lives in the profile and still loads. No remote employee, scoped or not, may have a `remoteCwd`
  in `<remote.root>/.jinn-departments`.
- **Its own `remoteCwd` is its work area**, named in the session's prompt and
  created on the host if it is missing. It
  must not be, contain or lie inside `<remote.root>/.jinn-departments` or
  `remote.mount`, and the mount must not overlap the departments directory; the
  employee is refused at load otherwise. At spawn the work area and the stage
  directory must also stay clear of the host's own stage directory
  (`~/.jinn-remote-stage`), which holds every session's gateway token; if that is
  not known, the spawn is refused.
- **The scope is the gateway's**, exactly as for a local scoped session. The
  environment file carries `JINN_DEPARTMENT`, and the jinn MCP server on the
  host attaches files only from the work area and the stage directory.

This is the same guardrail as locally, not a sandbox: the session's shell can
still reach the mounted instance home.

## The sandbox root

`remoteCwd` must resolve under `remote.root`, checked when the org loads and
again immediately before the spawn command is built. Traversal is normalized
away first, and a sibling that merely shares a prefix (`/srv/jinn-work-other`
against `/srv/jinn-work`) is refused.

This does not stop a determined prompt from `cd ..`-ing out of the directory
once the session is running. It is not a sandbox. What it does is bound the
realistic accidental blast radius of running unattended with
`--dangerously-skip-permissions` on a machine somebody also uses for other
things, which is the failure actually worth designing against.

## How the pieces reach back

The gateway's hook endpoint only accepts loopback connections, and that check is
not relaxed for remote sessions. Instead the session's `ssh` carries a reverse
forward (`-R`) from a free port on the remote host back to the gateway's own
port. The remote `hook-relay.mjs` and the remote MCP servers talk to
`127.0.0.1:<forwarded port>`, so their requests arrive at the gateway as genuine
loopback traffic with no change to the authentication path at all.

The port is probed on the remote immediately before the spawn, and the session
is started with `ExitOnForwardFailure=yes`. If something claimed the port in
between, `ssh` exits at once instead of running a session whose hooks could
never arrive — a fast, visible failure rather than a turn that hangs forever.

Each session gets its **own** `$JINN_HOME` on the remote host, at
`~/.jinn-remote-stage/sessions/<session id>`: a directory of symlinks into the
mount, rebuilt on every spawn, with two exceptions — `gateway.json` (staged for
real, naming that session's forwarded port) and `tmp/` (a real local directory,
because per-session files churn there and a network filesystem is the wrong
place for it).

Per session rather than per host, because `gateway.json` names a port that is
allocated per spawn. With one shared copy, any second prepare — another employee
on the same box — rewrites the port a live session's hook relay is about to
read. The relay swallows a failed POST by design, so that turn would run to
completion with no `Stop`, no `PreToolUse` policy, and nothing reported
anywhere. Stale session directories are reaped after seven days by the same
script that rebuilds the farm.

`hook-relay.mjs` and `remote-trust-seed.mjs` are staged as real copies at
`~/.jinn-remote-stage/` itself — deliberately outside every session's farm, so
the farm rebuild cannot turn them back into symlinks into the mount. Hooks fire
many times a turn, and a relay that cannot run because the mount blipped would
take the turn's completion signal with it. Their presence is re-checked on every
spawn (the farm script reports it, at no extra cost), so a wiped stage restages
itself rather than staying broken until the gateway restarts.

`JINN_GATEWAY_URL` (pointing at the tunnel) and `JINN_GATEWAY_TOKEN` are written
into a 0600 shell fragment under the session's `tmp/` and sourced by the remote
command. The system prompt tells every session both are already exported, and
every documented `curl` in it — delegation included — depends on that being
true. They are sourced from a file rather than inlined into the remote command
because a command line is readable by every process on that host.

## When the host is off

A desktop is usually off, so this is part of the feature rather than an error
case. When a turn starts and the host is unreachable, the gateway sends the wake
(`wakeCommand`, else a Wake-on-LAN magic packet), moves the session to
`waiting`, tells the operator, and polls until `waitMs` runs out.

A `wakeCommand` gets `wakeTimeoutMs` (default five minutes) to finish. That is
deliberately generous: a real startup path is not a fire-and-forget packet — it
may probe reachability, read a power state over the network, press a physical
ATX button and then wait for the machine to POST. Killing it partway through can
land between the state read and the press, so nothing wakes and the turn simply
times out. Give the command room to complete rather than backgrounding it, so
its exit code and stderr are still yours to read when it fails. On success the
turn proceeds; on timeout the turn fails with a message naming the host.

Two deliberate asymmetries:

- **The dashboard's terminal view never wakes anything.** Opening a tab should
  not boot someone's machine, so the idle path probes and reports rather than
  waking.
- **Nothing is written to the engine-health store.** That store is keyed by
  engine *name* and is consulted for every session, so recording "claude is
  unavailable" because one desktop is asleep would hold back every local
  employee's turns too.

`jinn remote status` reports what a turn would find right now, without waking
anything. `jinn remote wake <employee>` brings a host up without queueing work
into it. Neither is on the turn path — a turn wakes and verifies its own host,
because making that depend on somebody remembering to run a command would put
"the session silently never started" back on the table.

## Known limits

- **Cost and transcript accounting read empty for remote turns.** The gateway
  reads Claude Code transcripts from its own home; a remote session writes them
  on the remote host. `--resume` is unaffected — the remote CLI manages its own
  transcript consistently across turns.
- **A lost `Stop` hook cannot be recovered from the transcript** for the same
  reason, so a genuinely stalled remote turn fails rather than recovering its
  text.
- **No status-line readings**, since the recorder would write where the gateway
  cannot read. The account's own usage reading over SSH (above) stands in for
  them; a host asleep since boot has none.
- **Attachments are refused** on remote turns: the paths are local to the
  gateway and would name nothing on the other machine.
- **The write guardrail is defence in depth, not a sandbox.** The `PreToolUse`
  policy refuses writes to an instance-home-shaped path outside the verified
  mount, and understands `/`, `~/` and `$HOME/` targets. It cannot see a path
  assembled at runtime, one built inside `python -c`, or one reached through a
  relative `cd`. The **mount sentinel** is the primary guard precisely because
  it does not read the command at all: it is verified before every spawn and
  refuses to start the session when the mount is not live. The policy also errs
  towards over-blocking — it refuses when a write-shaped command mentions an
  offending path anywhere, not only as its target — which is the safe direction
  for a rule of this kind.
- **Only the `claude`, `pi` and `opencode` engines can go remote.** Every other
  engine ignores `remoteHost`, so a remote employee configured with one has its turns
  refused rather than silently run on the gateway. `jinn remote status` says so
  per employee.
- **A remote Pi turn has no dashboard terminal view**, because a Pi turn has none
  locally either: it is a headless JSON run, not a TUI.
- **Secrets reach a second machine.** The gateway's API bearer token and any MCP
  server API keys are staged into 0600 files on the remote host, and the mount
  makes the instance home — including `secrets/` — readable there. This is
  inherent to a remote employee being as capable as a local one. Treat the
  remote host as being inside the same trust boundary as the gateway, and do not
  point this at a machine you would not give the instance home to.
