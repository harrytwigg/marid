# Upgrading from an earlier release

The codename is the lower-case word that names an instance's home (`~/.hundredfold`), its instance name (`hundredfold-<slug>`),
its environment variables (`HUNDREDFOLD_*`), its wire headers (`x-hundredfold-*`), its cookies, its stage directories, the
built-in MCP server (`mcp__hundredfold__*`) and a browser's stored keys. `packages/hundredfold/src/shared/codename.ts`
holds it as one literal, and everything else is built from that.

Throughout this page `<old>` is the codename an install was made under before the rename (and `<OLD>` its upper-case
form for variables). The names a build reads from older installs are written in exactly one file,
`packages/hundredfold/src/shared/legacy/names.json`; the compatibility layer is whatever imports it, and removing the
layer is deleting that file and its importers.

An install made before a change carries the old word in all of those places. The compatibility layer is the
code that lets such an install keep working under a build whose literal has changed, and then moves it over.
While the codename equals the old one every alias collapses to a single name and none of this does anything.

## What a build with a new codename does to an old install

| Stage | What happens | Who triggers it |
|---|---|---|
| Names | It reads the old spelling wherever an old peer or file can still carry it (environment, headers, flags, cookies, config key, roster key, plugin SDK specifier, browser storage) and writes the new one. A variable set only under the old name is adopted once, with one warning per name. | Automatic, every start |
| Home | The home is renamed (`~/.<old>-x` to `~/.hundredfold-x`), not copied, and a link is left at the old path. Claude Code files conversations by the physical working directory, so the project directories for the home and for each department stage directory move with it, in every profile. The host registry entry, the stage root, the snapshots and `gateway.json` follow. | The first command or start that finds the old home with nothing running at it, after a snapshot, under a lock |
| MCP name | The built-in server keeps its old registered name on an upgraded instance, so no prompt, skill or permission list changes underfoot. | Per instance, at the switch-over |
| Switch-over | Skills, cron prompts, the instance's own permission lists and rosters that say `mcp__<old>__*` or `<old>Mcp` are rewritten, the instance block in `config.yaml` is keyed by the new name, and the registered name flips, last. A Claude profile's settings, which every instance on the host shares, get the new tool names added beside the old ones. | You: `doctor --rename --apply`, gateway stopped |

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

- **Before the home moved**: nothing to undo for the home. An instance with remote departments is the exception: the
  stage directories on a remote host move at the next department spawn whether or not the home has, so the old build
  would find `.<old>-departments` gone there. Move `<remote root>/.hundredfold-departments/<department>` back to
  `<remote root>/.<old>-departments/<department>` on that host, and each `projects/<slug of the new path>` under the
  Claude profile there back to `projects/<slug of the old path>`, then stay on, or return to, the old build.
- **After the home moved, before the switch-over**:
  1. Stop the gateway.
  2. Remove the link at the old path and rename the directory back (`~/.hundredfold-x` to `~/.<old>-x`).
  3. Move each Claude project directory back: `projects/<slug of the new path>` to `projects/<slug of the old path>`, in
     every profile. The move's receipt, `state/home-move.json`, names the home and the stage directories it moved.
  4. Move the stage root back (`.hundredfold-departments/.instances/.hundredfold-x` to `.<old>-departments/.instances/.<old>-x`) and
     rename the snapshot directories likewise.
  5. Set the registry entry's name and home back (`~/.config/hundredfold/instances.json`). The old registry file is left in
     place, but it is not updated after the move: copy back only the entry's name and home, and keep anything the
     new build changed in the new file.
  6. If the instance has remote departments, move their stage directories and conversations back as described above.
  Skipping step 3 loses nothing, but a resumed session starts a fresh conversation, as one does when Claude Code cannot
  find the old one; the files are still there.
- **After the switch-over**: also restore the instance's own files it edited from `.migration-backups/rename-<time>/`
  (the receipt, `state/rename-switchover.json`, lists them), which puts the instance block, the rosters, the skills and
  the permission lists back and the built-in server back under its old name. A Claude profile's settings need no
  restoring: they only gained entries, and the old ones were never removed.

Each of those is a manual rollback because each is a deliberate, rare event. Take the snapshot (`backup run`) before
the first start of a new build: the move takes one of its own, and so does the switch-over.

## What is kept under the old spelling on purpose

Two things are never renamed because renaming them would invalidate stored data: the domain-separation strings that
key capabilities, auth sessions and bootstrap grants, and the SQLite function names a database's schema refers to
(the callback and Todo-claim functions). The `.claude.json` backup and lock suffixes and the mount sentinel
stay as they are too: the first is a one-time backup, the second is regenerated.

## Installing the new package over the old one

The package was renamed with the product. The old package is not removed by installing the new one, and both want a
command named after the old product, so a global install of one over the other can stop with `EEXIST`. The new package
ships a small forwarder under the old command name that prints a notice and runs the new command, so scripts that call
the old name keep working. To switch cleanly, remove the old global package first, then install the new one:

```bash
npm uninstall -g <old package>
npm install -g hundredfold
```

Your home, configuration and conversations are untouched by either command; the first start of the new build moves
the home over as described above.

## Docker

The Compose project, its volumes and the home inside the container were renamed with the product. A volume is looked
up by its name, so the first `docker compose up` of this release creates **empty** volumes beside the old ones, and
the gateway would start a fresh instance. Keep your data by doing one of these before the first start:

- Copy each old volume into its new one. Stop the old stack (`docker compose down`, without `-v`), list the old volumes
  with `docker volume ls` (they are named `<old project>_<old name>-home`, `-claude` and `-codex`), create the new
  ones (`docker compose create`), then copy one volume at a time:

  ```bash
  docker run --rm -v <old volume>:/from -v hundredfold_hundredfold-home:/to alpine sh -c 'cp -a /from/. /to/'
  ```

  Repeat with `hundredfold_hundredfold-claude` and `hundredfold_hundredfold-codex`.
- Or keep using the old volumes: declare them `external: true` in your Compose file under their old names and mount
  them where the new ones are mounted.

Then `docker compose up -d`. The home in the container is a mount point, so it is never renamed: its path inside the
container is the new one from the start, and the first command that runs there files the conversations that the Claude
volume holds under the old home path and the old department stage directories under the new ones (once, noted in
`state/legacy-transcripts-checked`), so sessions resume. Anything you wrote into a file of your own that names the old
directory (`/home/node/.<old>`) has to be edited by hand.

Variables in your `.env` file or `docker run` command that carry the old prefix are still honoured: the entrypoint
gives each one the new prefix, unless the new name is already set. Moving to the new names is still the way to stop
the warning. The old command is not installed inside the image; use `hundredfold`.

## Desktop and mobile apps

The desktop and mobile apps use new application identifiers and a new URL scheme, so they install as new apps.
Add your gateways again in the new app and remove the old one when you are ready. Nothing is deleted from the old app.

## Checking an upgrade

`scripts/verify-codename-upgrade.mjs` rehearses all of this on a throwaway host: it builds an instance with an old
build, runs turns against a stand-in `claude` that refuses a conversation filed under the wrong directory, then starts a
build with another codename against the old home path, as an operator's service unit would, and checks the move, the
registry, resume, fork and compaction through the real gateway, and the switch-over. See the script's header for its
inputs.
