# Surviving a change of codename

The codename is the lower-case word that names an instance's home (`~/.jinn`), its instance name (`jinn-<slug>`),
its environment variables (`JINN_*`), its wire headers (`x-jinn-*`), its cookies, its stage directories, the
built-in MCP server (`mcp__jinn__*`) and a browser's stored keys. `packages/jinn/src/shared/codename-constant.ts`
holds it as one literal, and everything else is built from that.

An install made before a change carries the old word in all of those places. The compatibility layer is the
code that lets such an install keep working under a build whose literal has changed, and then moves it over.
While the literal is unchanged every alias collapses to a single name and none of this does anything.

## What a build with a new codename does to an old install

| Stage | What happens | Who triggers it |
|---|---|---|
| Names | It reads the old spelling wherever an old peer or file can still carry it (environment, headers, flags, cookies, config key, roster key, plugin SDK specifier, browser storage) and writes the new one. A variable set only under the old name is adopted once, with one warning per name. | Automatic, every start |
| Home | The home is renamed (`~/.jinn-x` to `~/.<new>-x`), not copied, and a link is left at the old path. Claude Code files conversations by the physical working directory, so the project directories for the home and for each department stage directory move with it, in every profile. The host registry entry, the stage root, the snapshots and `gateway.json` follow. | The first command or start that finds the old home with nothing running at it, after a snapshot, under a lock |
| MCP name | The built-in server keeps its old registered name on an upgraded instance, so no prompt, skill or permission list changes underfoot. | Per instance, at the switch-over |
| Switch-over | Skills, cron prompts, permission lists and rosters that say `mcp__<old>__*` or `<old>Mcp` are rewritten, the instance block in `config.yaml` is keyed by the new name, and the registered name flips, last. | You: `doctor --rename --apply`, gateway stopped |

`doctor` reports where an instance stands in all four and never changes anything. `doctor --rename` reports what
the switch-over would change, and `--apply` makes the change after a snapshot, keeping a copy of every file it edits
under `.migration-backups/rename-<time>/`.

A home that is a mount point (a container's volume) is never moved: its path stays and only the names change.
A home that cannot be moved (a gateway is running there, the snapshot failed, the old path is a link elsewhere) is
used under its old name, and `doctor` says why. If both the old and the new directory exist, nothing is touched until
you decide which holds your data.

Things to know about the move itself:

- The first command on a large home takes a full snapshot before it moves anything, and prints nothing while it does.
  A second process that meets the lock waits up to a minute, then uses the home under its old name for that command.
- A move that is killed after the rename leaves a note, `state/home-move-pending.json`, in the moved home. The next
  command or start finishes the remaining steps (the link, the conversations, the stage root, the registry, the
  receipt) and removes it.
- On a remote host the stage directories are moved at the next department spawn, one by one: each stage directory
  the new container does not have yet moves across with its conversations, one that exists in both is left as it
  is, and one that a process on the host has as its working directory (a live session would otherwise have its
  conversations filed under a key that no longer matches) stays where it is and is tried again at the next
  spawn. The one case this does not repair: a department's stage directory that is in use at that department's first spawn after the
  upgrade is staged afresh in the new container, so the two then both exist and the older conversations stay under the
  old one (a resume of those sessions starts fresh). Where `/proc` cannot be read on the host that check is skipped. The
  old container goes once it is empty.

## Rolling back

The old build keeps working against a moved home: it finds it through the link, reads the old names it wrote, and
ignores the new ones. What it cannot do is find conversations, which now sit under the new keys.

- **Before the home moved**: nothing to undo. Stay on, or return to, the old build.
- **After the home moved, before the switch-over**:
  1. Stop the gateway.
  2. Remove the link at the old path and rename the directory back (`~/.<new>-x` to `~/.jinn-x`).
  3. Move each Claude project directory back: `projects/<slug of the new path>` to `projects/<slug of the old path>`, in
     every profile. The move's receipt, `state/home-move.json`, names the home and the stage directories it moved.
  4. Move the stage root back (`.<new>-departments/.instances/.<new>-x` to `.jinn-departments/.instances/.jinn-x`) and
     rename the snapshot directories likewise.
  5. Set the registry entry's name and home back (`~/.config/<new>/instances.json`; the old registry file is left in place
     and is still current for every other field).
  Skipping step 3 loses nothing, but a resumed session starts a fresh conversation, as one does when Claude Code cannot
  find the old one; the files are still there.
- **After the switch-over**: also restore the files it edited from `.migration-backups/rename-<time>/` (the receipt,
  `state/rename-switchover.json`, lists them), which puts the instance block, the rosters, the skills and the permission
  lists back and the built-in server back under its old name.

Each of those is a manual rollback because each is a deliberate, rare event. Take the snapshot (`backup run`) before
the first start of a new build: the move takes one of its own, and so does the switch-over.

## What is kept under the old spelling on purpose

Two things are never renamed because renaming them would invalidate stored data: the domain-separation strings that
key capabilities, auth sessions and bootstrap grants, and the SQLite function names a database's schema refers to
(`jinn_callback_identity`, `jinn_work_item_claim_*`). The `.claude.json` backup and lock suffixes and the mount sentinel
stay as they are too: the first is a one-time backup, the second is regenerated.

## Checking an upgrade

`scripts/verify-codename-upgrade.mjs` rehearses all of this on a throwaway host: it builds an instance with an old
build, runs turns against a stand-in `claude` that refuses a conversation filed under the wrong directory, then starts a
build with another codename against the old home path, as an operator's service unit would, and checks the move, the
registry, resume, fork and compaction through the real gateway, and the switch-over. See the script's header for its
inputs.
