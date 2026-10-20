import fs from "node:fs";
import path from "node:path";
import { JINN_HOME } from "./paths.js";

/**
 * What the Freebuff screen last said about the account's hours, kept between
 * turns. Freebuff has no quota endpoint and no JSON mode: the only place the
 * balance appears is the panel above its chat (`17/21 hours remaining`) and the
 * session clock beside the input (`53m left`), so this is the screen's word as
 * of the last time a turn read it.
 *
 * Advisory and best-effort, like the Muse Code snapshot beside it: a read that
 * fails is "no data", a write that fails is skipped.
 */
export interface FreebuffUsageSnapshot {
  observedAtMs: number;
  /** Hours left today, and the daily allowance, from the panel. */
  hoursRemaining?: number;
  hoursTotal?: number;
  /** Minutes left in the running hour session, when one is running. */
  sessionLeftMinutes?: number;
  /** The model the status bar showed. */
  modelLabel?: string;
}

export function freebuffUsageFile(): string {
  return path.join(JINN_HOME, "tmp", "freebuff-usage.json");
}

function isSnapshot(value: unknown): value is FreebuffUsageSnapshot {
  const v = value as Partial<FreebuffUsageSnapshot> | null;
  return !!v && typeof v === "object" && Number.isFinite(v.observedAtMs);
}

export function readFreebuffUsage(file: string = freebuffUsageFile()): FreebuffUsageSnapshot | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return isSnapshot(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Keep `usage` as the latest snapshot, unless the file already holds a newer one. */
export function writeFreebuffUsage(usage: FreebuffUsageSnapshot, file: string = freebuffUsageFile()): void {
  try {
    const held = readFreebuffUsage(file);
    if (held && held.observedAtMs > usage.observedAtMs) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(usage), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // best-effort only
  }
}
