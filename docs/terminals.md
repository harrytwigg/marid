# Terminals

A terminal is a login shell on the gateway or on another machine, opened from
the chat sidebar and shown in the chat grid like any chat.

## Opening one

The sidebar's **Terminals** section sits above **Team**. Its **+** menu lists
every machine the gateway can open a shell on:

- **Open a terminal on** replaces the current pane with the new terminal.
- **Open beside the current chat** adds it to the chat grid next to what is open.

Terminal sessions are listed under that header. Rename, pin, delete, drag into
the grid and **Open beside** all work on them, because a terminal is a session
(`engine` and `source` are both `terminal`). A terminal never runs an agent
turn: a message sent to it is refused with 409, and it has no composer.

On a desktop the terminal is a real terminal: click it, type, paste, scroll,
select and copy (Ctrl/Cmd+C with a selection, Ctrl+Shift+C/V). The viewer
that has focus answers the programs' terminal queries (cursor position,
colours), so `vim`, `less` and friends work. On a touch device the terminal is
display-only with swipe-to-scroll, plus a command line, a `^C` button and the
key bar below it.

The shell outlives its viewers. Closing the pane or reloading the page leaves
it running; reopening shows the last screen and reattaches. It ends when it
exits, when its session is deleted, or when the gateway stops. An exited shell
stays exited — reloading, resizing or opening it elsewhere shows the exit and
**Restart terminal**, and nothing respawns it (or re-runs its ssh login) until
you press that. After a gateway restart the shell is gone; opening the terminal
starts a new one.

## Hosts

Nothing is hardcoded. The host list comes from the instance's configuration:

1. **The gateway itself**, labelled with its hostname.
2. **Every `terminal.hosts` entry** (below).
3. **Every distinct `remoteHost` the org's employees run on**, reached with the
   same `ssh` destination the employees use, starting in `remote.root`. A
   configured host with the same destination replaces the derived one.

**On by default on every install**, including one that requires auth — no
config step after an upgrade. `terminal.enabled: false` turns the feature off:
`GET /api/terminals/hosts` then answers `enabled: false` with a
`disabledReason`, creating one returns 409, and the sidebar shows no section.

```yaml
terminal:
  enabled: true            # the default; false turns terminals off
  employeeHosts: true      # offer employees' remoteHosts (3)
  localLabel: Pi           # label for the gateway; default its hostname
  shell: /bin/zsh          # local shell; default $SHELL, else /bin/sh
  maxLive: 16              # live shells at once, across every host
  hosts:
    - id: build            # stored on each terminal session
      label: Build host
      host: 10.0.0.5  # hostname, address or ~/.ssh/config alias
      user: builder          # optional; ssh's own resolution otherwise
      cwd: /srv/jinn-work  # optional absolute start directory
```

A host whose `host`/`user` could reach ssh's option parser (a leading `-`, odd
characters) or whose `cwd` is not absolute is refused and reported in
`GET /api/terminals/hosts` → `problems`, as is a `hosts` that is not a list.
Derived hosts get the id `ssh:<destination>`. A terminal whose host is later removed
or disabled refuses to start rather than opening somewhere else.

Remote shells are `ssh -tt` sessions for a human, so unlike agent spawns they
are not `BatchMode`: ssh may ask to trust a new host key or for a password, and
you answer in the terminal. `EscapeChar=none` stops a pasted `~.` dropping the
connection. The start-directory step runs under `/bin/sh` whatever the remote
login shell is (fish and nu cannot parse it), then execs your `$SHELL -l`. A sleeping host is not woken; ssh's own error is shown and
**Restart terminal** tries again.

## Security

- Operator-only. `GET /api/terminals/hosts`, `POST /api/terminals` and the
  `/ws/pty/:id` upgrade all refuse agent sessions and unidentified tool calls.
- A terminal's `/ws/pty` upgrade from a browser must come from the gateway's
  own origin (the `Origin` host must equal `Host` or `X-Forwarded-Host`), so a
  sibling subdomain behind the same tunnel cannot ride the auth cookie into a
  shell. The live event stream `/ws` and plugin event sockets have the same
  rule; see the reverse-proxy note under Configuration in the README.
- On by default; `terminal.enabled: false` is the off switch for an install
  that should never offer a browser shell.
- The shell gets a login's environment only (`HOME`, `USER`, `PATH`, `LANG`,
  `LC_*`, `SSH_AUTH_SOCK`, …). The gateway's own environment, which holds every
  credential loaded from `secrets/` and session identity variables, is not
  passed through.
- The terminal's screen is kept in gateway memory only — never under the
  instance home, where agents could read it — and is dropped when the session
  is deleted.
- `/stop` and `/reset` refuse a terminal (409); it has no turn. Delete ends it.

## API

| Call | Does |
|---|---|
| `GET /api/terminals/hosts` | `{ enabled, hosts: [{ id, label, kind, detail, destination, cwd }], problems }` |
| `POST /api/terminals { hostId }` | Creates the terminal session (201). The shell starts when a viewer attaches to `/ws/pty/:id`. |
| `DELETE /api/sessions/:id` | Ends the shell and deletes the session. |
