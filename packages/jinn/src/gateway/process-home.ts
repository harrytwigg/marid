import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { JINN_HOME_IDENTITY, resolveHomeIdentity } from "../shared/paths.js";

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
      timeout: 1_000,
    });
    return jinnHomeFromEnvEntries(output.split(/\s+/));
  } catch {
    return { status: "unknown" };
  }
}

function jinnHomeFromEnvEntries(entries: string[]): ProcessJinnHomeLookup {
  let jinnHome: string | undefined;
  let identity: string | undefined;
  for (const entry of entries) {
    if (entry.startsWith("JINN_HOME=")) {
      jinnHome = entry.slice("JINN_HOME=".length);
    } else if (entry.startsWith("JINN_HOME_IDENTITY=")) {
      identity = entry.slice("JINN_HOME_IDENTITY=".length);
    }
  }
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
