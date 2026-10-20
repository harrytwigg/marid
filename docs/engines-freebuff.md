# Freebuff Engine

[Freebuff](https://freebuff.com) is a free terminal coding agent (the `freebuff` CLI). It has no print mode, no JSON mode and no way to pass it a prompt: it is a full-screen terminal program. Marid runs the real program in a terminal, types into it, and reads what it draws.

> **Check that you may.** Freebuff's terms restrict bots and automated use of its free access. Marid drives the CLI the way a person would, but that is still automation. Use this engine only with Freebuff's permission, or under terms that allow it.

> **It is billed in hours, not money.** The first message of an hour session spends hours from a daily allowance, at the model's multiplier (`1x` for the cheapest model). Every extra process opens a session of its own and is charged again. See [Concurrency](#concurrency).

---

## Installation

```bash
npm install -g freebuff
freebuff login
```

`freebuff login` opens a browser and stores the token in the operating system's keyring. Marid resolves the binary from `PATH` (or `engines.freebuff.bin`) and never reads or writes Freebuff's credentials. It only checks that `~/.config/manicode/credentials.json` exists before starting the CLI, because a CLI that is not signed in shows a login page on its first message and nobody is there to finish it.

Run `freebuff -v` to see the version Marid was written against (0.2.30).

---

## Configuration

```yaml
engines:
  freebuff:
    bin: freebuff                  # optional: PATH-resolved when absent
    model: MiMo v2.6 Flash Slow    # a prefix of a label in the CLI's /model picker; unset leaves the CLI's choice alone
    effortLevel: high              # the level shown after the bullet in the picker; unset leaves it alone
    maxConcurrent: 1               # live Freebuff processes at once, across the gateway and every remote host
    fallback: [claude]             # chain targets to try when Freebuff cannot serve a turn (docs/fallback-chains.md)
```

An employee runs on it with `engine: freebuff`:

```yaml
name: scribe
engine: freebuff
model: MiMo v2.6 Flash Slow        # set this: see below
effortLevel: high                  # optional
persona: |
  You write release notes.
```

**The model.** Set `model:` on the employee to a picker label. Employee files default to `model: sonnet`, and that default (like any Claude alias, `claude-…` or `gpt-…` id) is not a Freebuff label, so Marid sets it aside, says so in the log, and uses `engines.freebuff.model`, else leaves the CLI's own choice. A label that is set but matches no picker row still fails the turn, naming the labels the picker showed.

---

## How a turn runs

1. The CLI starts as `freebuff --cwd <dir> --trust-agents` (plus `--continue <chatId>` to resume). `--trust-agents` skips the folder-trust question, which nobody is there to answer.
2. Its output goes into a headless terminal (`@xterm/headless`) and the visible rows are read as text. A parser turns them into a state (`signed-out`, `idle`, `busy`, `picker` or `unknown`) plus the session clock, the context tokens, the hours balance and the model on the status bar. Raw escape codes are never read, and the markers are read only from the CLI's own chrome (the input box, the bar under it, the panel, a line that is nothing but the sign-in text), never from the model's answer, which can say anything.
3. If `model` or `effortLevel` is set and the status bar disagrees, Marid opens `/model` and drives the picker one key at a time: ↓ and ↑ to the row, Tab to cycle its reasoning level, Enter to select. It then checks the status bar. The picker is the only place the CLI takes either setting, and a new process starts on its own default, so this runs on every cold start.
4. A new chat's context (the employee's persona and the platform context, which Freebuff has no flag for) is put in front of the first message. A resumed chat gets only the new message.
5. The message goes in as a bracketed paste, then Enter. A long or multi-line message arrives as one message and does not submit early: verified with a 39 KB, 614-line paste. Freebuff keeps a long paste as an attachment of the message.
6. The turn is over when the screen has gone busy and then idle again with the `⎘ • 11s` footer up for a moment.
7. The answer is read from Freebuff's own chat file, not the screen: the text after the last tool call in the last completed reply to the message (the text before a tool call is the model thinking aloud; when the reply ends on a tool call, its last text is the answer). The file embeds the run state and is about a megabyte a turn, so it is read only after the screen says the turn is over and then only when its stat changes (one `stat` per poll, over ssh too). If the file cannot be read, Marid falls back to the text on the screen and logs a warning.

`engineSessionId` is the chat id (an ISO time with `:` replaced by `-`, for example `2026-10-20T15-50-31.145Z`). The process stays warm between turns, so the next turn reuses it; a cold start resumes the chat with `--continue`, and Freebuff re-joins the hour session already running.

Two checkouts can share a basename, so the newest chat is never taken on trust. A new chat is the one that did not exist before the process started, that no other Marid session owns, and whose first message is the one that was sent (read from the chat's metadata or, for a pasted message, from its attachment).

Usage: `cost` is 0 (Freebuff bills hours) and `contextTokens` is the figure on the status line. The hours balance and the time left in the session are kept in `tmp/freebuff-usage.json` in the instance home and shown on the Limits page as "daily hours" and "session". The balance is on screen only before a session's first message, so it is kept from the last reading that had it (and goes stale a day after that reading); the session clock is as of the last turn.

---

## Concurrency

`engines.freebuff.maxConcurrent` (default `1`) caps the number of live Freebuff processes across the gateway and every remote host together, because each extra process opens another hour session and spends hours again.

- A warm process waiting for its next turn holds a slot but can be given away: when another session's turn needs a slot, the idle process with the longest wait is stopped and its chat resumes later with `--continue`. Stopping a process appears to end the hour session it held (the hours balance goes back up by the whole hours it had not spent, and a process started right after found the account's session released), so the next process's first message starts a new session. This was seen in one run and not studied further.
- A process serving a turn is never stopped. A turn that finds every slot busy waits its turn, first in first out, and does not fail.
- The dashboard's terminal view never queues: it starts only when a slot is free or idle.

---

## Remote (SSH)

An employee with `remoteHost` and `remoteCwd` runs Freebuff over `ssh -tt`, on the same remote targets, `remote.root` rule and `pathPrepend` handling as the other remote engines. What differs:

- Nothing of the gateway's is needed on the host: no mount, no staged home, no reverse tunnel, no hooks. The host needs `freebuff` on the non-interactive `PATH` (the nvm default Node is found), a signed-in Freebuff, and the same `jinn-cli` version as the gateway (the chat file is read through the host's own file-read policy, `remote-file-read`).
- The chat file is read over ssh, and new chats are found by listing the host's `~/.config/manicode/projects`.
- The first message of a remote chat says where it really runs, because the context built for every employee names the gateway's home as the working directory and a model will believe it.

---

## When it cannot run

| What the screen says | What the turn does |
|---|---|
| Signed out (`Press ENTER to login...`, or a login URL) | Fails with `freebuff is not signed in on <local\|remote>; run "freebuff login" there`. Marid never presses Enter on the sign-in screen. |
| `0/21 hours remaining` before a session starts, `Not enough hours`, `Session limit reached`, `Too many Freebuff sessions on this network` | A rate limit, so the configured `fallback` engines take over. |
| `concurrent-session limit … Take over` | Fails: only a person at the terminal can take another session over. |
| The hour session ran out while the process sat idle | Nothing to do: the screen goes back to the panel that says `Your first message starts the session.` (seen on a real expiry), and the next message starts a new session, which spends hours again. |
| `This session was released` before the model starts answering (the hour ran out under a warm process) | The process is stopped and started again once and the message sent again, which re-joins the chat and starts a new session. |
| The model ends the turn with no text (an API error on its side) | Fails with the end of the screen in the error. |
| A model or level the picker does not have | Fails with the labels the picker showed. Nothing is sent. |
| A screen nothing recognises for 60 s | Fails with that screen in the error. |

The refusal messages come from the CLI's own wording as of 0.2.30. A refusal counts only when its line starts with the words (after a margin, a border or a glyph), is not inside a user message, and appeared after the message went in; the model's answer is never read for them. One limit: a second paragraph of the user's own message that starts with one of these phrases is read as a refusal.

---

## Known limits

- **No Marid MCP.** Freebuff loads MCP servers only from a repository's `mcp.json`, and writing one into an employee's checkout is too invasive. A Freebuff employee has no company tools. It sees only the persona and context pasted in front of its first message.
- **No system-prompt flag, no per-turn streaming.** The reply arrives when the turn ends.
- **The terminal view shares the process.** The dashboard locks its view switch while a turn runs, but a message typed in the terminal between turns goes into the same session and is not copied into the chat. The CLI and the screen reader stay at least 160 columns wide whatever size the dashboard pane is (it scrolls), because the status bar wraps below that.
- **A session that ends mid-turn has not been seen.** The hour session is an hour long and a turn is bounded at two; if one ever ends mid-answer, the screen is whatever Freebuff draws then, and a screen Marid does not recognise fails the turn after 60 seconds with that screen in the error. The next turn re-joins the chat.
- **The hours balance can go up.** Freebuff refunds the whole hours an ended session did not spend, so the `daily hours` figure on the Limits page is a reading, not a running total.
- **Untested on Windows.** The engine needs a PTY and `ssh`; it has only been run on Linux.
