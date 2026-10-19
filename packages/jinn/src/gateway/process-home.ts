import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { JINN_HOME_IDENTITY, resolveHomeIdentity } from "../shared/paths.js";
import { recordedByAnotherHome, startupGatewayPids, type GatewayInfo } from "./gateway-info.js";
import { envAliases } from "../shared/codename-env.js";

export type ProcessJinnHomeLookup =
  | { status: "found"; jinnHome: string; identity: string }
  | { status: "none" }
  | { status: "unknown" };

export function readProcessJinnHome(pid: number): ProcessJinnHomeLookup {
  if (process.platform === "win32") return { status: "unknown" };

  const procEnvPath = `/proc/${pid}/environ`;
  if (fs.existsSync(procEnvPath)) {
    try {
      const raw = fs.readFileSync(procEnvPath, "utf-8");
      return jinnHomeFromEnvEntries(raw.split("\0"));
    } catch {
      return { status: "unknown" };
    }
  }

  try {
    const output = execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });
    return jinnHomeFromEnvEntries(output.split(/\s+/));
  } catch {
    return { status: "unknown" };
  }
}

function jinnHomeFromEnvEntries(entries: string[]): ProcessJinnHomeLookup {
  // A process an older build started names its home under that build's codename; the current name wins.
  const pairs = new Map(entries.flatMap((entry) => {
    const separator = entry.indexOf("=");
    return separator < 0 ? [] : [[entry.slice(0, separator), entry.slice(separator + 1)] as const];
  }));
  const firstOf = (names: string[]): string | undefined => names.map((name) => pairs.get(name)).find((value) => value !== undefined);
  const jinnHome = firstOf(envAliases("HOME"));
  const identity = firstOf(envAliases("HOME_IDENTITY"));
  if (jinnHome || identity) {
    const publicHome = jinnHome ?? identity!;
    return { status: "found", jinnHome: publicHome, identity: identity ?? resolveHomeIdentity(publicHome) };
  }
  return { status: "none" };
}

/**
 * A live process whose environment names a different home than `identity`. A gateway
 * and every PTY it spawns carry their home in their environment, so a pid recorded in a
 * copied home's gateway.json or PID file is recognisably another instance's.
 */
export function pidBelongsToAnotherHome(pid: number, identity: string = JINN_HOME_IDENTITY): boolean {
  const owner = readProcessJinnHome(pid);
  return owner.status === "found" && owner.identity !== identity;
}

/**
 * The pids a booting gateway may treat as orphans of its own previous run. A
 * gateway.json written by another home — the home was copied from a running instance —
 * names that instance's live gateway and sessions, as does any pid whose environment
 * names another home, and none of them is ours to signal.
 */
export function reapableGatewayPids(
  info: Partial<GatewayInfo> | null | undefined,
  identity: string = JINN_HOME_IDENTITY,
  currentPid = process.pid,
): number[] {
  if (recordedByAnotherHome(info, identity)) return [];
  return startupGatewayPids(info, currentPid).filter((pid) => !pidBelongsToAnotherHome(pid, identity));
}
