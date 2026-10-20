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

/** What a screen's panel and clock say, as the snapshot to keep: undefined when they say nothing. */
export function usageFromScreen(
  info: { hoursRemaining?: number; hoursTotal?: number; sessionLeftMinutes?: number; statusBar?: { modelLabel: string } },
  observedAtMs: number = Date.now(),
): FreebuffUsageSnapshot | undefined {
  if (info.hoursRemaining === undefined && info.sessionLeftMinutes === undefined) return undefined;
  return {
    observedAtMs,
    ...(info.hoursRemaining !== undefined ? { hoursRemaining: info.hoursRemaining } : {}),
    ...(info.hoursTotal !== undefined ? { hoursTotal: info.hoursTotal } : {}),
    ...(info.sessionLeftMinutes !== undefined ? { sessionLeftMinutes: info.sessionLeftMinutes } : {}),
    ...(info.statusBar ? { modelLabel: info.statusBar.modelLabel } : {}),
  };
}

/** One log line for a reading. */
export function describeUsage(usage: FreebuffUsageSnapshot, context?: { tokens?: number; pct?: number }): string {
  const hours = usage.hoursRemaining !== undefined ? `${usage.hoursRemaining}/${usage.hoursTotal ?? "?"} hours left today` : "hours unknown";
  const session = usage.sessionLeftMinutes !== undefined ? `, ${usage.sessionLeftMinutes}m left in this session` : "";
  const tokens = context?.tokens !== undefined ? `, ${context.tokens} context tokens (${context.pct ?? "?"}%)` : "";
  return `Freebuff: ${hours}${session}${tokens}`;
}
