# ADR 0004: A department-scoped session runs as its own OS user

- Status: proposed (waiting on the operator's decision, see "Decisions needed")
- Date: 2026-10-07
- Decision owners: the operator

## Context

A department-scoped session is kept in scope by the gateway and the `jinn` MCP tools
(`specs/005-department-scoping/spec.md`, "Scope of the boundary"). Feature 005 chose not to
make that an OS boundary (Q1 = A) and listed the containment work under "Deferred to future
sandbox work". This ADR is that work's decision.

The allow-listed environment (`shared/child-env.ts`, `SCOPED_SESSION_ENV_EXACT`) stops a
scoped session *inheriting* the gateway's variables. It does not stop the session *reading*
them, because the session's engine, its shell, its hooks and its MCP servers all run as the
gateway's own OS user. Paths below are relative to `packages/jinn/src/`.

### What a scoped session can still reach

Ranked by how little effort each takes:

| # | Route | Where |
| --- | --- | --- |
| R1 | **It is handed the operator's gateway token.** `JINN_GATEWAY_TOKEN` is on the scoped allow-list. A remote stage exports it in its environment file, and also stages a trimmed `gateway.json` into the session home carrying the token and the instance hook secret. With the token, the shell can call any gateway route as the operator, including starting an unscoped session that has every MCP server. `SSH_AUTH_SOCK` is also kept, so the operator's SSH agent signs for it | `shared/child-env.ts:81`, `engines/remote-stage.ts:1252` and `:1305`, `gateway/server.ts:510`. A request with the token and no session capability is not a scoped caller: `gateway/department-scope/caller.ts:27` |
| R2 | The gateway's start-time environment, from `/proc/<gateway pid>/environ`. This is where `config.yaml` `${VAR}` credentials live when a service unit or shell exports them | `shared/env-ref.ts` |
| R3 | **Any other process the same user runs**, by the same route: every unscoped engine (R1's token), every third-party MCP server of every session (its resolved `${VAR}` credentials), every `jinn` MCP server (its session capability) | `mcp/resolver.ts:206`, `mcp/identity.ts` |
| R4 | Files the gateway user can read: `gateway.json`, `config.yaml`, the instance `secrets/`, the capability key file, the session registry, and `tmp/mcp/<session>/config.json` for **every** session, each holding that session's MCP credentials already resolved. Outside the home: the operator's `~/.claude`, `~/.config/gh`, `~/.ssh`. On a remote host, the gateway home mounted over sshfs (`docs/remote-execution.md`) | `mcp/resolver.ts:227` |
| R5 | The loopback API with auth off, which is the default unless `gateway.authRequired` is set. Reads need no credential: a request with none gets another department's session (200). Mutations are refused (403) unless the request looks like a same-origin browser request, and that test is made from `Sec-Fetch-*` and `Origin` headers that `curl` can forge. A forged request creates a Todo as the operator (201). This holds for a process of any user on the host | `gateway/auth.ts:264`, `gateway/api.ts:623` and `:818` |
| R6 | The auth-exempt routes. `POST /api/internal/hook` needs the `x-jinn-hook-secret` header, and with it accepts a hook for any session's id (200). That secret is one per instance: it sits in `gateway.json` (R4) and is staged to remote hosts (R1) | `gateway/auth.ts:250`, `gateway/api.ts:4575`, `gateway/hook-endpoint.ts` |

The `/proc` route in R2 is the one reported. R1 needs no `/proc` at all, and R3 and R4 mean
that hiding the gateway process alone changes nothing: the same secrets sit in other
processes and in files the same user owns. R5 and R6 were measured against a throwaway
gateway with auth off and a seeded scoped department.

### What was measured

Linux 6.14, bubblewrap 0.11, Yama `ptrace_scope=1`, AppArmor
`restrict_unprivileged_userns=1`. A parent started as `FOO_API_KEY=sekrit` spawns a child
with only `PATH` in its environment. The child reads `/proc/$PPID/environ`.

**Host assumption.** Every result below is with Yama `ptrace_scope=1`, which only lets a
process attach to its own descendants. Where it is `0`, a same-user process can also attach
to the gateway, or read `/proc/<pid>/mem`, and so read its whole heap, every resolved secret
included. Options C and D still hold there: a non-dumpable process and a process of another
uid both refuse the attach. Option A does not.

| # | Mitigation in the parent | Child reads the parent's `FOO_API_KEY`? |
| --- | --- | --- |
| 1 | None (today) | **Yes** |
| 2 | Node `delete process.env.FOO_API_KEY` before spawning | **Yes**. `/proc/<pid>/environ` is the start-time block, which `unsetenv` does not touch |
| 3 | `prctl(PR_SET_DUMPABLE, 0)` | No, `Permission denied` |
| 4 | Child wrapped in `bwrap --unshare-pid --proc /proc`, reading the outer parent's real pid | No. The child sees only its own namespace's pids, and the parent's pid does not exist there (`No such file`) |
| 5 | None, reading a sibling same-user process instead of the parent | **Yes** |
| 6 | Reader runs as a different uid in the same pid namespace | No, `Permission denied` (the pid is still listed) |
| 7 | `/proc` mounted `hidepid=invisible` | Same uid: **pid listed and environ read**. Different uid: pid hidden |

## Options

Each option is scored against R1 to R6.

### A. Secrets from files, and the gateway scrubs its own environment

The gateway reads `${VAR}` values from a secrets file (or systemd `LoadCredential=`) rather
than its environment, and deletes them from `process.env` after resolving.

- Closes: R2, but only if the secrets never reach the gateway's start-time environment.
  Scrubbing after start does nothing (measurement 2).
- Fails: R1, R3, R4. The secrets file is readable by the same user, and the resolved values
  still reach other sessions' MCP servers and their `tmp/mcp` config files. With
  `ptrace_scope=0` it does not even close R2, because the resolved secrets sit in the
  gateway's heap.
- Verdict: hygiene, not a boundary.

### B. `hidepid` on `/proc`

- Closes nothing on its own. `hidepid` hides processes of *other* users, and a scoped
  session is the same user (measurement 7).
- Useful only alongside D, to hide the gateway user's command lines as well as its
  environments. Linux only, and a host-wide mount option.

### C. Make the gateway non-dumpable

`prctl(PR_SET_DUMPABLE, 0)` in the gateway process.

- Closes: R2 (measurement 3).
- Fails: R1, R3, R4. Every engine and MCP server is a fresh `execve` and dumpable again.
- Cost: a native addon, because Node exposes no `prctl`. Linux only.
- Verdict: closes the reported reproduction and nothing else.

### D. A separate OS user per scoped department (recommended, subject to a spike)

A scoped department names an unprivileged OS user. That department's engines run as that
user. Everything an engine starts (shell, Task sub-agents, hooks, MCP servers) inherits the
uid.

- Closes:
  - R2 and R3, by the kernel's uid check (measurement 6), whatever `ptrace_scope` is.
  - R4, by ordinary file modes, as long as no group of the scoped user can read the gateway
    home, the instance home, or the operator's `~/.claude`, `~/.config/gh` and `~/.ssh`. On
    a remote host, an sshfs mount without `allow_other` refuses every user but the one that
    mounted it.
  - R1, R5 and R6 only with P, which this option requires.
  - macOS, **unverified**: process environments (`ps -E`, `KERN_PROCARGS2`) are expected to
    be limited to the same user there too. This was not measured on a Mac.
- Fails, by design or out of reach:
  - The network. The user can reach anything on the LAN, the loopback gateway, and on a
    remote host the loopback port of the SSH tunnel back to the gateway. So this option
    requires `gateway.authRequired: true` and P. Abstract Unix sockets have no permission
    check at all, so any service listening on one is reachable.
  - World-readable files on the host, and a shared `/tmp`. The session gets a private
    `TMPDIR`.
  - The credentials of the MCP servers its own department allow-lists. They are the
    session's to use, so it can read them.
  - **A confused deputy.** The gateway, the more privileged user, would read paths the
    scoped user controls: transcripts, the Claude profile, the stage dir. The scoped user can
    swap a transcript for a symlink to the gateway's `gateway.json` or `secrets/`, and the
    gateway would read it and might relay it back. Every such read opens with `O_NOFOLLOW`
    and checks the owner, or is done by a process running as the scoped user. The handoff
    directory the gateway writes into is writable by the gateway user only.
  - Kernel bugs.
- What it takes. This is a supervisor design, not a change to the launch line:
  - **Root, once per host**: create the user and a group of its own for that department
    (never the operator's primary group, or one department could read another's handoff
    files), and add one sudoers line letting the gateway user run commands as that user
    without a password. That rule only runs things *as a less privileged user*, never the
    reverse. The scoped user MUST NOT be in `sudo`, `wheel`, `admin` or `docker` (membership
    of `docker` is root).
  - **A per-department supervisor.** The gateway cannot do the following itself across a uid
    boundary, so it starts one supervisor per department through `sudo` and asks it to do
    them:
    - *Kill.* `kill(2)` across uids returns EPERM, `kill(-pgid)` included. Where sudoers sets
      `use_pty`, the command runs in sudo's own session and pty, so the gateway can signal
      only `sudo`. sudo relays most signals but cannot relay SIGKILL. A SIGKILLed `sudo`
      would leave the engine's background children and MCP servers running, out of the
      gateway's reach. Every kill, and the reaping, has to run as the scoped user.
    - *Transcripts.* Claude Code writes transcripts `0600` in `0700` directories. Because
      the mode is explicit, a group ACL grants nothing. The transcript tailer
      (`engines/transcript-tailer.ts:78`) and the consent flags the gateway seeds into the
      profile both need a reader or writer running as the scoped user.
    - *Launch.* Settings, MCP config and environment go in a handoff file, never on argv,
      which any user can read.
  - **Binaries the scoped user can run.** Claude Code, the jinn CLI (with the hook relay and
    the `jinn` MCP server) and the Node that pnpm uses are typically installed under the
    operator's home, which other users cannot traverse. They need a system-wide install or
    one per scoped user.
  - **Working directories.** A repository owned by the operator trips git's "dubious
    ownership" check for another user. The department's working directories are owned by
    its user, or listed in its `safe.directory`.
  - **Its own credentials.** git, `gh` and the Claude profile (FR-050) belong to the
    scoped user. This is the "friend's account" case the feature was built for.
  - **macOS, unverified.** Claude Code keeps its sign-in in the login Keychain, and a user
    reached through `sudo` has no unlocked login keychain. This may stop D working on macOS
    without a different credential store.
  - Gateway code that assumes its engines share its uid: the launch in
    `engines/claude-interactive.ts` (through `node-pty`), the 26 `process.kill` sites (several
    of them SIGKILL; EPERM must read as alive), and the two modules that read `/proc`.
- Blast radius: the sudoers line and the group memberships are root-level host changes.
  Getting either wrong (a scoped user that can `sudo`, a home readable by one of its groups)
  silently voids the boundary, so the gateway checks them before every scoped launch
  (below). Unscoped employees, and departments with no OS user named, are unchanged.

### E. A namespace sandbox around the whole engine

The gateway launches a scoped engine inside `bwrap` with its own pid namespace, `$HOME`
replaced by a tmpfs, and only the department's working directories, stage dir, Claude
profile and toolchain paths bound in. (Claude Code's own `sandbox` setting is narrower: it
wraps the Bash tool, while file tools, hooks and MCP servers run outside it. research.md,
"Containment", items 1 to 10, lists what would have to be proven for it.)

- Closes: R2 and R3 (measurement 4) and R4 for every path left unbound. R1, R5 and R6
  only with P.
- Fails: anything shared at the same uid that is not explicitly hidden: abstract Unix
  sockets (the network namespace is shared, because the session needs the network), the
  user's session bus under `/run/user`, an SSH agent socket, `/tmp`. Every new tool that
  needs a path means a new bind, and a mistaken bind is a silent hole.
- Cost: no new users. Linux only: macOS needs a separate `sandbox-exec` profile with its own
  gaps. bubblewrap is not installed by default on every distribution, and some restrict the
  unprivileged user namespaces it needs.
- Verdict: the fallback if the operator will not create OS users.

### P. Scoped sessions never hold an instance-wide credential (required by D and E)

- Scoped sessions, local and remote, get no `JINN_GATEWAY_TOKEN` and no `SSH_AUTH_SOCK`, and
  a remote scoped stage gets no `gateway.json` with the token or the hook secret in it
  (`engines/remote-stage.ts:1252`).
- With `authRequired`, the gateway admits a request that carries a valid session capability
  and no bearer token, to that session's scoped route surface only.
- The hook relay carries a per-session hook credential on its command, and
  `POST /api/internal/hook` checks it against the session it names, in place of the shared
  `x-jinn-hook-secret` (the hook relay item under spec 005 "Deferred to future sandbox
  work").
- For a scoped session, the `jinn` MCP server reads neither `gateway.json` nor the key file.
- A scoped department on an instance without `authRequired` is refused at config load. That
  also closes R5, because the same-origin browser test applies only when auth is off.

On its own, under one uid, P is not a boundary: R3 still hands out the token from any
unscoped engine. It removes the zero-effort routes, though, and both D and E depend on it.

## Decision (proposed)

**P now, then D, if a spike shows the supervisor works.** One OS user per scoped
department, with P, and `authRequired` mandatory for any department that names a user.
`hidepid=invisible` (option B) is documented as optional hardening on Linux. A and C are not
built. E is the fallback if D is declined or the spike fails.

Why D over E: the uid is a boundary the kernel already enforces for environments, files and
signals, whatever `ptrace_scope` is, and every descendant inherits it, so there is no
allow-list of paths, sockets and process routes to keep complete. E's failure mode is a
missed path, and it cannot be seen from inside the session. This is measured on Linux only.
Whether D works on macOS at all (the Keychain) is open.

## How it would be built

1. **P** (no host changes). Tests:
   - a scoped session's environment has no gateway token, and a remote scoped stage has no
     token or hook secret;
   - a request from its shell with no credential gets 401;
   - with its capability, an out-of-scope route is refused;
   - a hook for another session's id is refused;
   - a scoped department is refused on an instance with auth off, so a mutation with forged
     `Sec-Fetch-Site`, `Sec-Fetch-Mode`, `Sec-Fetch-Dest` and `Origin` headers cannot be
     made as the operator.
2. **Spike for D**, time-boxed, on Linux, in a container where it can create users: a
   supervisor started through `sudo` with `use_pty` launches a Claude Code session as the
   scoped user, streams its transcript to the gateway, delivers a turn, and kills it so
   that nothing of the session's process tree survives. If any of those cannot be made to
   work, stop and come back with E.
3. **D**:
   - `department.yaml` gains an optional `runAs` naming the OS user.
   - The per-department supervisor, and the gateway changes listed under D.
   - A preflight runs before every scoped launch and refuses the launch if any check fails.
     As that user: `gateway.json`, the instance home, the operator's home and `~/.ssh` are
     unreadable, `/proc/<gateway pid>/environ` is unreadable, and `sudo -n true` fails. The
     gateway's own checks: the user is not the gateway's user, its group is its own and no
     other department's, it is in no admin group, and `authRequired` is on.
   - Setup docs with the exact commands, run once by the operator.
4. **Acceptance test.** An end-to-end test on Linux: a container (where the test can create
   the user) runs a throwaway gateway with a credential in its environment and an MCP
   credential in `config.yaml`, then starts a scoped session as the department's user. That
   session's shell runs the escape checks, and each must fail:
   - the reported reproduction, R1, R3, `gateway.json`, `config.yaml`, another session's
     `tmp/mcp` config, the operator's `~/.ssh`, `ps -eww`;
   - replacing its own transcript with a symlink to `gateway.json`: the gateway must not
     read through it.

   `git` and a build in the department's working directory must succeed.

## Decisions needed

1. **Boundary**: D, a separate OS user per department, with its spike first (recommended);
   E, a bubblewrap sandbox at the same uid; or stay at the guardrail and document it as one.
2. **P now**: ship P on its own before D (recommended: yes, it needs no host changes).
3. **Granularity**: one user per department (recommended) or per session. Per session needs
   root at runtime to create users.
4. **Remote hosts**: apply D to scoped sessions on remote hosts as well, which also closes
   the sshfs-mounted gateway home there (recommended: yes, in the same work).

## Consequences

- An instance that wants a contained department must make root-level changes on each host
  that runs it. Nothing changes for an instance that does not.
- A contained department cannot use the operator's git, `gh`, SSH or Claude credentials. It
  needs its own.
- "Scoped" then means "cannot reach the company setup", for local and remote sessions
  alike, except over the network to services that do not authenticate it.
