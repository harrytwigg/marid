import fs from "node:fs";
import path from "node:path";
import type { EngineLimitEngineSnapshot, EngineLimitsResponse, JinnConfig, Session } from "../shared/types.js";
import { CLAUDE_LIMITS_DIR } from "../shared/paths.js";
import { isDefaultAccountSession } from "../shared/engine-account.js";
import { collectEngineLimits } from "../shared/engine-limits.js";
import { isEngineExhausted, readEngineHealth } from "../shared/engine-health.js";
import { readClaudeUsageHistory, type UsageSample } from "../shared/claude-usage-history.js";
import { isSystemEmployeeName } from "../gateway/system-employees.js";
import { isLegacyWorkflowPhaseSession } from "../sessions/legacy-workflow-phase.js";
import { projectWindow, type WindowProjection } from "./projection.js";
import { countStarts, listStartedSessions, type StartCounts, type StartedSession } from "./started-sessions.js";
import type { PriorFiveHour } from "./store.js";

/**
 * The capacity snapshot: everything the board walk knows about capacity, in
 * one structure the prompt carries verbatim. Readings, predictions and signals
 * only — no verdict. Whether any of it means "start something" is the rules
 * file's call, read by the model; nothing here compares a number to a limit.
 *
 *   - every engine's live limit readings (the collector the Limits page and
 *     `jinn limits` use), with reset times and minutes to reset;
 *   - predictions for the Claude windows from the retained usage history;
 *   - per engine: sessions holding capacity now, and sessions started in the
 *     current five-hour window, by what started them;
 *   - the operator-activity signals, as times and deltas, not as a "live" flag.
 */

export interface SnapshotWindow {
  name: string;
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: string;
  minutesToReset?: number;
  /** A prediction drawn from the retained readings, not a reading. */
  prediction?: WindowProjection;
}

export interface SnapshotEngine {
  name: string;
  status: EngineLimitEngineSnapshot["status"];
  stale?: boolean;
  note?: string;
  plan?: string;
  exhausted: boolean;
  windows: SnapshotWindow[];
  holdingCapacityNow: number;
  /** Sessions started on this engine since its five-hour window opened, when
   *  the engine reports one; otherwise over the last five hours. The walk's
   *  own turns are left out. */
  startedThisWindow: StartCounts & { since: string };
}

export interface OperatorSignals {
  /** Newest activity on a session the operator drives (top-level, not cron, not a system employee). */
  lastOperatorSessionActivity?: { at: string; minutesAgo: number };
  /** Newest turn in a Jinn Claude session the operator drives (its statusline snapshot). */
  lastInteractiveCliTurn?: { at: string; minutesAgo: number };
  /** The Claude five-hour usage since the previous tick's reading of the same window. */
  claudeUsageSincePreviousTick?: {
    previousAt: string;
    previousUsedPercent: number;
    usedPercentNow: number;
    risePoints: number;
    /** Whether any Jinn session was running or active in between — when none
     *  was, the rise was spent outside Jinn, i.e. by the operator. */
    jinnSessionActiveInBetween: boolean;
  };
}

export interface CapacitySnapshot {
  now: string;
  timezone: string;
  localTime: string;
  weekday: string;
  engines: SnapshotEngine[];
  /** Engines the registry knows but that have no usable reading at all. */
  enginesWithoutReadings: string[];
  sessionsHoldingCapacityNow: number;
  operator: OperatorSignals;
}

export interface SnapshotDeps {
  config: JinnConfig;
  timezone: string;
  now: number;
  sessions: readonly Session[];
  holdingCapacity: (sessions: readonly Session[]) => Session[];
  prior?: PriorFiveHour;
  collect?: (config: JinnConfig) => Promise<EngineLimitsResponse>;
  usageHistory?: (sinceMs: number) => UsageSample[];
  statuslineMtime?: () => number | undefined;
  startedSince?: (sinceMs: number, engine: string) => StartedSession[];
  exhausted?: (engine: string, now: number) => boolean;
}

// ── Operator signals (moved from the retired idle-capacity loop) ─────────────

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

/** The newest statusline snapshot written by a session the operator drives.
 *  Every Jinn Claude session installs the recorder and writes
 *  `<session id>.json` on each turn — the walk's own turn, cron and delegated
 *  work included — so a snapshot only says "the operator" when its session is
 *  one they drive. A file whose session the registry does not list is not
 *  counted. */
export function newestOperatorStatuslineMtime(sessions: readonly Session[], dir = CLAUDE_LIMITS_DIR): number | undefined {
  const driven = new Set(sessions.filter(operatorDrivenSession).map((session) => session.id));
  try {
    const stamps = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json") && driven.has(name.slice(0, -".json".length)) && isDefaultAccountSession(name.slice(0, -".json".length)))
      .map((name) => fs.statSync(path.join(dir, name)).mtimeMs);
    return stamps.length > 0 ? Math.max(...stamps) : undefined;
  } catch {
    return undefined;
  }
}

/** Was any Jinn session active at or after `sinceMs` — holding capacity now,
 *  or with activity since? */
export function jinnActiveSince(sessions: readonly Session[], sinceMs: number, holding: readonly Session[]): boolean {
  if (holding.length > 0) return true;
  return sessions.some((session) => Date.parse(session.lastActivity) >= sinceMs);
}

// ── Assembly ─────────────────────────────────────────────────────────────────

const minutesBetween = (from: number, to: number): number => Math.max(0, Math.round((to - from) / 60_000));
const sighting = (at: number | undefined, now: number) => at === undefined ? undefined : { at: new Date(at).toISOString(), minutesAgo: minutesBetween(at, now) };

export function localClock(now: number, timezone: string): { localTime: string; weekday: string } {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long" }).format(new Date(now));
  return { localTime: fmt.format(new Date(now)), weekday };
}

/** The Claude five-hour window from a reading, when it has a reset still ahead. */
export function claudeFiveHour(snapshot: EngineLimitEngineSnapshot | undefined, now: number): PriorFiveHour | undefined {
  const window = snapshot?.windows?.find((entry) => entry.name === "5h");
  if (window?.usedPercent === undefined || window.resetsAt === undefined || window.resetsAt * 1000 <= now) return undefined;
  return { resetsAt: window.resetsAt, usedPercent: window.usedPercent, atMs: now };
}

function snapshotWindows(engine: EngineLimitEngineSnapshot, now: number, history: UsageSample[]): SnapshotWindow[] {
  return (engine.windows ?? []).map((window) => {
    const minutesToReset = window.resetsAt !== undefined ? Math.round((window.resetsAt * 1000 - now) / 60_000) : undefined;
    const prediction = engine.name === "claude" && history.length > 0 ? projectWindow(history, window.name, now) : undefined;
    return {
      name: window.name,
      ...(window.usedPercent !== undefined ? { usedPercent: window.usedPercent } : {}),
      ...(window.windowDurationMins !== undefined ? { windowMinutes: window.windowDurationMins } : {}),
      ...(window.resetsAt !== undefined ? { resetsAt: new Date(window.resetsAt * 1000).toISOString() } : {}),
      ...(minutesToReset !== undefined ? { minutesToReset } : {}),
      ...(prediction ? { prediction } : {}),
    };
  });
}

/** When the engine's five-hour window opened, or five hours ago when it reports none. */
function windowStart(engine: EngineLimitEngineSnapshot, now: number): number {
  const fiveHour = engine.windows?.find((window) => window.name === "5h" || window.windowDurationMins === 300);
  if (fiveHour?.resetsAt !== undefined && fiveHour.resetsAt * 1000 > now) {
    return fiveHour.resetsAt * 1000 - (fiveHour.windowDurationMins ?? 300) * 60_000;
  }
  return now - 5 * 60 * 60_000;
}

const USABLE: ReadonlySet<EngineLimitEngineSnapshot["status"]> = new Set(["live", "snapshot", "static"]);

function unusableNote(engine: EngineLimitEngineSnapshot): string {
  const why = engine.unsupportedReason ?? engine.error;
  return `${engine.name} (${engine.status}${why ? `: ${why}` : ""})`;
}

interface EngineContext {
  now: number;
  history: UsageSample[];
  holding: readonly Session[];
  startedSince: (sinceMs: number, engine: string) => StartedSession[];
  exhausted: (engine: string, now: number) => boolean;
}

function snapshotEngine(engine: EngineLimitEngineSnapshot, ctx: EngineContext): SnapshotEngine {
  const since = windowStart(engine, ctx.now);
  return {
    name: engine.name,
    status: engine.status,
    ...(engine.stale ? { stale: true } : {}),
    ...(engine.unsupportedReason ? { note: engine.unsupportedReason } : {}),
    ...(engine.accountPlan ? { plan: engine.accountPlan } : {}),
    exhausted: ctx.exhausted(engine.name, ctx.now),
    windows: snapshotWindows(engine, ctx.now, ctx.history),
    holdingCapacityNow: ctx.holding.filter((session) => session.engine === engine.name).length,
    // The walk's own turns are not starts of work; counting them would read
    // as the walk having already spent its starts for the window.
    startedThisWindow: {
      ...countStarts(ctx.startedSince(since, engine.name).filter((session) => session.startedBy !== "board-walk")),
      since: new Date(since).toISOString(),
    },
  };
}

function operatorSignals(deps: SnapshotDeps, claude: EngineLimitEngineSnapshot | undefined, holding: readonly Session[]): OperatorSignals {
  const { now, sessions, prior } = deps;
  const operator: OperatorSignals = {};
  const operatorAt = sighting(newestOperatorSessionActivity(sessions), now);
  if (operatorAt) operator.lastOperatorSessionActivity = operatorAt;
  const cliAt = sighting(deps.statuslineMtime ? deps.statuslineMtime() : newestOperatorStatuslineMtime(sessions), now);
  if (cliAt) operator.lastInteractiveCliTurn = cliAt;
  const fiveHour = claudeFiveHour(claude, now);
  if (fiveHour && prior && prior.resetsAt === fiveHour.resetsAt) {
    operator.claudeUsageSincePreviousTick = {
      previousAt: new Date(prior.atMs).toISOString(),
      previousUsedPercent: prior.usedPercent,
      usedPercentNow: fiveHour.usedPercent,
      risePoints: Math.round((fiveHour.usedPercent - prior.usedPercent) * 10) / 10,
      jinnSessionActiveInBetween: jinnActiveSince(sessions, prior.atMs, holding),
    };
  }
  return operator;
}

function engineContext(deps: SnapshotDeps, holding: readonly Session[]): EngineContext {
  const health = deps.exhausted ? undefined : readEngineHealth();
  return {
    now: deps.now,
    history: (deps.usageHistory ?? readClaudeUsageHistory)(deps.now - 7 * 24 * 60 * 60_000),
    holding,
    startedSince: deps.startedSince ?? ((sinceMs, engine) => listStartedSessions(sinceMs, { engine })),
    exhausted: deps.exhausted ?? ((engine, at) => isEngineExhausted(health!, engine, new Date(at))),
  };
}

export async function buildCapacitySnapshot(deps: SnapshotDeps): Promise<CapacitySnapshot> {
  const limits = await (deps.collect ?? collectEngineLimits)(deps.config);
  const holding = deps.holdingCapacity(deps.sessions);
  const ctx = engineContext(deps, holding);
  const all = Object.values(limits.engines);
  return {
    now: new Date(deps.now).toISOString(),
    timezone: deps.timezone,
    ...localClock(deps.now, deps.timezone),
    engines: all.filter((engine) => USABLE.has(engine.status)).map((engine) => snapshotEngine(engine, ctx)),
    enginesWithoutReadings: all.filter((engine) => !USABLE.has(engine.status) && engine.available).map(unusableNote),
    sessionsHoldingCapacityNow: holding.length,
    operator: operatorSignals(deps, limits.engines.claude, holding),
  };
}
