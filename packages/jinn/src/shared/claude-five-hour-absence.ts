/**
 * Whether a Claude account's plan has no five-hour limit, kept per account.
 *
 * The usage API can report a zero `session` bucket for a plan that has no
 * five-hour limit, which reads exactly like a real limit sitting idle. The
 * CLI's statusline snapshot settles it: it is taken from the rate-limit
 * headers of real requests, so a recent one with a weekly reading and no
 * five-hour one shows the plan has none. That finding is stored, because the
 * snapshot that proved it ages while the account is idle, and idleness is
 * when a phantom bar is most visible. Only evidence undoes it, never time: a
 * snapshot that carries a five-hour window, a usage-API five-hour reading
 * above zero, or a change of plan.
 */
import fs from "node:fs";
import path from "node:path";
import { ENGINE_LIMITS_DIR } from "./paths.js";
import type { EngineLimitWindow } from "./types.js";
import { isRecord, str } from "./engine-limits-util.js";

/** The CLI's statusline reading for one account, and when it was written. */
export interface ClaudeStatuslineEvidence {
  windows: EngineLimitWindow[];
  capturedAtMs: number;
}

/** How recent a weekly-only snapshot must be to establish that the plan has no
 *  five-hour limit: one five-hour span, so a request made in any five-hour
 *  window the account had would have carried that window's header. */
export const STATUSLINE_EVIDENCE_MAX_AGE_MS = 5 * 60 * 60_000;

/** What is stored once an account is found to have no five-hour limit. */
export interface FiveHourAbsence {
  /** When it was established (ISO). */
  since: string;
  /** The plan the account was on then, when known; a different plan later clears it. */
  accountPlan?: string;
}

export interface FiveHourEvidence {
  /** The account's latest statusline snapshot, at any age. */
  statusline: ClaudeStatuslineEvidence | null | undefined;
  /** The usage API's windows for the account, as read this time. */
  usageWindows: EngineLimitWindow[];
  /** The account's plan now; undefined when it could not be read, which changes nothing. */
  accountPlan?: string;
  nowMs: number;
}

export function fiveHourAbsencePath(account: string): string {
  return path.join(ENGINE_LIMITS_DIR, `claude-five-hour-absent.${encodeURIComponent(account)}.json`);
}

function hasFiveHour(windows: EngineLimitWindow[]): boolean {
  return windows.some((window) => window.name === "5h");
}

function establishes(statusline: ClaudeStatuslineEvidence | null | undefined, nowMs: number): boolean {
  if (!statusline || nowMs - statusline.capturedAtMs > STATUSLINE_EVIDENCE_MAX_AGE_MS) return false;
  return statusline.windows.some((window) => window.name === "7d") && !hasFiveHour(statusline.windows);
}

function planChanged(stored: FiveHourAbsence, accountPlan: string | undefined): boolean {
  return stored.accountPlan !== undefined && accountPlan !== undefined && stored.accountPlan !== accountPlan;
}

/**
 * The stored finding after this reading's evidence: cleared by a snapshot
 * with a five-hour window, a usage-API five-hour reading above zero, or a
 * plan change; established by a recent weekly-only snapshot; otherwise kept
 * as it was, however long the account has been idle.
 */
export function nextFiveHourAbsence(
  stored: FiveHourAbsence | undefined,
  evidence: FiveHourEvidence,
): FiveHourAbsence | undefined {
  if (showsFiveHour(evidence)) return undefined;
  if (stored && !planChanged(stored, evidence.accountPlan)) return withPlan(stored, evidence.accountPlan);
  if (!establishes(evidence.statusline, evidence.nowMs)) return undefined;
  return withPlan({ since: new Date(evidence.nowMs).toISOString() }, evidence.accountPlan);
}

/** Evidence the account has a five-hour limit: the CLI saw one, or the usage API reads one above zero. */
function showsFiveHour(evidence: FiveHourEvidence): boolean {
  if (evidence.statusline && hasFiveHour(evidence.statusline.windows)) return true;
  return evidence.usageWindows.some((window) => window.name === "5h" && !!window.usedPercent);
}

/** The finding with the plan filled in when it was not known before. */
function withPlan(absence: FiveHourAbsence, accountPlan: string | undefined): FiveHourAbsence {
  return absence.accountPlan === undefined && accountPlan !== undefined ? { ...absence, accountPlan } : absence;
}

function readAbsence(file: string): FiveHourAbsence | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!isRecord(parsed)) return undefined;
    const since = str(parsed.since);
    if (!since) return undefined;
    const accountPlan = str(parsed.accountPlan);
    return { since, ...(accountPlan !== undefined ? { accountPlan } : {}) };
  } catch {
    return undefined;
  }
}

function writeAbsence(file: string, absence: FiveHourAbsence | undefined): void {
  if (!absence) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(absence));
  fs.renameSync(tmp, file);
}

/**
 * Apply this reading's evidence to the account's stored finding, store the
 * result, and say whether the account has no five-hour limit. A store that
 * cannot be written still answers from this reading.
 */
export function settleFiveHourAbsence(account: string, evidence: FiveHourEvidence, file = fiveHourAbsencePath(account)): boolean {
  const stored = readAbsence(file);
  const next = nextFiveHourAbsence(stored, evidence);
  if (JSON.stringify(next) !== JSON.stringify(stored)) {
    try {
      writeAbsence(file, next);
    } catch {
      // Best effort: the finding is re-established from the next weekly-only snapshot.
    }
  }
  return next !== undefined;
}

/** The windows without a five-hour one at zero. Any reading above zero stands:
 *  it proves the limit exists (and clears the finding on the same reading). */
export function withoutZeroFiveHour(windows: EngineLimitWindow[]): EngineLimitWindow[] {
  return windows.filter((window) => window.name !== "5h" || !!window.usedPercent);
}
