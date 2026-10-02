import fs from "node:fs";
import path from "node:path";
import { CLAUDE_LIMITS_DIR } from "../shared/paths.js";
import type { IdleCapacityPolicy } from "../shared/idle-capacity-config.js";
import type { IdleCapacityWindowReading } from "../shared/idle-capacity.js";
import type { Session } from "../shared/types.js";
import { isSystemEmployeeName } from "./system-employees.js";
import { isLegacyWorkflowPhaseSession } from "../sessions/legacy-workflow-phase.js";

/**
 * Is the operator live? The idle-capacity auto-start backs off
 * almost entirely while they are, so the question needs a precise answer.
 * Nothing in the gateway can see a Claude Code session on another machine, so
 * the answer is built from the three signals the gateway does have:
 *
 *   1. A session the operator drives — a top-level chat from the dashboard or
 *      a connector (`operatorDrivenSession`) — with activity inside the idle
 *      window. The operator reading a reply and typing the next message is an
 *      active session, even though no turn is running.
 *   2. A Jinn interactive Claude session (the dashboard's CLI mode, a PTY)
 *      installs a statusline recorder that writes `<session>.json` into
 *      `CLAUDE_LIMITS_DIR` on every turn (`shared/claude-settings.ts`). The
 *      newest file's mtime is the last moment the operator drove Claude that way.
 *   3. Usage the system did not spend is the operator's. If the five-hour
 *      window's used share rose by `usageDeltaPercent` or more between two
 *      readings of the same window, and no Jinn session was active in
 *      between, someone outside Jinn — the operator, on any machine — spent
 *      it. This is the one signal that reaches a laptop session.
 *
 * Any signal marks the operator as seen; they count as live for `idleMinutes`
 * after the latest one. The error direction is deliberate: a Jinn session too
 * brief to be caught between two ticks can read as the operator, which backs
 * the loop off — the safe way to be wrong.
 *
 * Only `observe` folds a reading into the delta signal, and only the tick
 * calls it: a preview that observed would shorten the interval the next
 * tick's delta is measured over and hide the operator from the very page that
 * explains why the loop is holding.
 */

export type OperatorSignal = "operator-session" | "jinn-interactive-session" | "usage-outside-jinn";

export interface OperatorSighting {
  /** Epoch ms of the latest sign of the operator, or undefined for none yet. */
  seenAt?: number;
  source?: OperatorSignal;
}

export interface OperatorActivityDeps {
  /** Newest activity, epoch ms, over sessions the operator drives. */
  operatorSessionActivityAt: () => number | undefined;
  /** Newest statusline snapshot mtime, epoch ms; undefined when none exists. */
  interactiveActivityAt: () => number | undefined;
  /** Whether any Jinn session was active (holding capacity, or with activity)
   *  at or after `sinceMs`. */
  jinnActiveSince: (sinceMs: number) => boolean;
}

/** A session whose turns the operator initiates: top-level (no parent — a
 *  delegated or spawned child has one), not started by cron or a Workflow, and
 *  not a system employee's (the Dispatcher and Shaper are started by the
 *  gateway on the operator's behalf, not driven by them). */
export function operatorDrivenSession(session: Session): boolean {
  if (session.parentSessionId) return false;
  if (session.source === "cron" || isLegacyWorkflowPhaseSession(session)) return false;
  return !session.employee || !isSystemEmployeeName(session.employee);
}

export function newestOperatorSessionActivity(sessions: readonly Session[]): number | undefined {
  const stamps = sessions.filter(operatorDrivenSession)
    .map((session) => Date.parse(session.lastActivity))
    .filter((stamp) => Number.isFinite(stamp));
  return stamps.length > 0 ? Math.max(...stamps) : undefined;
}

/** Was any Jinn session active at or after `sinceMs` — holding capacity now,
 *  or with activity since? The usage-delta signal asks this to tell the
 *  system's own spend from the operator's. */
export function jinnActiveSince(sessions: readonly Session[], sinceMs: number, holdingCapacity: (sessions: readonly Session[]) => boolean): boolean {
  if (holdingCapacity(sessions)) return true;
  return sessions.some((session) => Date.parse(session.lastActivity) >= sinceMs);
}

/** The newest `*.json` under the Claude limits dir, by mtime. */
export function newestStatuslineMtime(dir = CLAUDE_LIMITS_DIR): number | undefined {
  try {
    const stamps = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => fs.statSync(path.join(dir, name)).mtimeMs);
    return stamps.length > 0 ? Math.max(...stamps) : undefined;
  } catch {
    return undefined;
  }
}

interface PriorReading { resetsAt: number; usedPercent: number; atMs: number }

export class OperatorActivity {
  private sighting: OperatorSighting = {};
  private prior: PriorReading | undefined;

  constructor(private readonly deps: OperatorActivityDeps) {}

  /** Fold this tick's evidence in and say whether the operator is live now.
   *  Tick-only: it advances the delta signal's reference reading. */
  observe(fiveHour: IdleCapacityWindowReading | undefined, policy: IdleCapacityPolicy, nowMs: number): boolean {
    this.noteSessions();
    if (fiveHour) {
      if (this.usageRoseOutsideJinn(fiveHour, policy)) this.sighting = { seenAt: nowMs, source: "usage-outside-jinn" };
      this.prior = { resetsAt: fiveHour.resetsAt, usedPercent: fiveHour.usedPercent, atMs: nowMs };
    }
    return this.isLive(policy, nowMs);
  }

  /** The read-only signals plus what earlier ticks saw; safe for a preview. */
  isLive(policy: IdleCapacityPolicy, nowMs: number): boolean {
    this.noteSessions();
    return this.sighting.seenAt !== undefined && nowMs - this.sighting.seenAt <= policy.operatorActivity.idleMinutes * 60_000;
  }

  lastSighting(): OperatorSighting {
    return { ...this.sighting };
  }

  /** Session-based signals are timestamps read off durable state, so folding
   *  them in is idempotent: the newest sighting wins and nothing is consumed. */
  private noteSessions(): void {
    this.consider(this.deps.operatorSessionActivityAt(), "operator-session");
    this.consider(this.deps.interactiveActivityAt(), "jinn-interactive-session");
  }

  private consider(seenAt: number | undefined, source: OperatorSignal): void {
    if (seenAt !== undefined && seenAt > (this.sighting.seenAt ?? -Infinity)) this.sighting = { seenAt, source };
  }

  private usageRoseOutsideJinn(fiveHour: IdleCapacityWindowReading, policy: IdleCapacityPolicy): boolean {
    const prior = this.prior;
    if (!prior || prior.resetsAt !== fiveHour.resetsAt) return false;
    if (fiveHour.usedPercent - prior.usedPercent < policy.operatorActivity.usageDeltaPercent) return false;
    return !this.deps.jinnActiveSince(prior.atMs);
  }
}
