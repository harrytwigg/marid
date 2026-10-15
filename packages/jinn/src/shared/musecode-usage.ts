import fs from "node:fs";
import path from "node:path";
import { JINN_HOME } from "./paths.js";
import type { MuseUsageSnapshot } from "../engines/musecode-turn.js";

/**
 * The latest subscription usage a Muse Code host reported (`usage/changed`),
 * kept between turns. `muse serve` only knows usage it has seen in its own
 * process, so a host started to answer "how much is left" has nothing to say;
 * this file is what a turn's host last told the gateway.
 *
 * Advisory and best-effort, like the engine-health store: a read that fails is
 * "no data", a write that fails is skipped.
 */

export const MUSECODE_USAGE_FILE = path.join(JINN_HOME, "tmp", "musecode-usage.json");

function isSnapshot(value: unknown): value is MuseUsageSnapshot {
  const v = value as Partial<MuseUsageSnapshot> | null;
  return !!v && typeof v === "object"
    && Number.isFinite(v.observedAtMs) && typeof v.tier === "string"
    && !!v.window && Number.isFinite(v.window.usedPercent) && Number.isFinite(v.window.resetsAtMs)
    && !!v.weekly && Number.isFinite(v.weekly.usedPercent) && Number.isFinite(v.weekly.resetsAtMs);
}

export function readMusecodeUsage(file: string = MUSECODE_USAGE_FILE): MuseUsageSnapshot | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return isSnapshot(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep `usage` as the latest snapshot: written whole to a sibling file and
 * renamed into place, owner-only. Turns run concurrently, so one that
 * observed an older state than the file already holds does not replace it.
 */
export function writeMusecodeUsage(usage: MuseUsageSnapshot, file: string = MUSECODE_USAGE_FILE): void {
  try {
    const held = readMusecodeUsage(file);
    if (held && held.observedAtMs > usage.observedAtMs) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(usage), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // best-effort only
  }
}
