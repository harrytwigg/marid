import { assertNotRemoteStagedHome } from "../shared/local-db-guard.js";

/**
 * Commands that must never run against a remote session's staged home.
 *
 * A remote session's `$JINN_HOME` is a symlink farm over the gateway's live home
 * (FARM_SCRIPT). Code started from inside such a session inherits it, so before
 * this guard `jinn start` there launched a second gateway that migrated the live
 * registry over sshfs and wrote the real `gateway.pid` through the link, and
 * `jinn stop`/`restart` would signal a pid read from the gateway's file on a host
 * where it names some other process. `status` is refused too: it reads the
 * gateway's pid file as if the pid were on this host, and loading the gateway
 * module opens the registry. `pair`/`unpair` load the gateway server, which
 * opens the registry at import. Commands that touch neither (`limits`, `remote
 * status`, `skills`, `--version`) stay available.
 */
export const COMMANDS_REFUSED_IN_REMOTE_STAGE: ReadonlySet<string> = new Set([
  "setup",
  "start",
  "stop",
  "restart",
  "status",
  "pair",
  "unpair",
  "migrate",
  "nuke",
  "backup",
]);

/** Throws when the top-level command in `commandPath` (e.g. `["backup", "run"]`)
 *  is refused and `home` is a remote session's staged home. */
export function assertCommandAllowedInHome(commandPath: readonly string[], home: string): void {
  const top = commandPath[0];
  if (top === undefined || !COMMANDS_REFUSED_IN_REMOTE_STAGE.has(top)) return;
  assertNotRemoteStagedHome(home, `run \`jinn ${commandPath.join(" ")}\``);
}
