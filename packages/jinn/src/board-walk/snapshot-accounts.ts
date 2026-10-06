import { readClaudeUsageHistory, usageHistoryPath, type UsageSample } from "../shared/claude-usage-history.js";
import { DEFAULT_CLAUDE_ACCOUNT, sessionAccountKey } from "../shared/engine-account.js";
import { collectClaudeAccounts, type EngineLimitAccountSnapshot } from "../shared/engine-limits-accounts.js";
import type { EngineLimitEngineSnapshot, JinnConfig, Session } from "../shared/types.js";
import { listSessionsCreatedSince } from "../sessions/registry.js";
import { getWorkItem } from "../work-items/store.js";
import { UNROUTED } from "./accounts.js";
import { projectWindow } from "./projection.js";
import { countStarts, isBoardWalkTurn, startedBy, toStartedSession, type StartCounts } from "./started-sessions.js";
import type { BoardWalkState, PriorFiveHour } from "./store.js";

/**
 * The capacity snapshot per Claude account (spec FR-075): each account's
 * windows and prediction, whether it is recorded at its limit or has no live
 * reading, the sessions holding it now, the starts made on it in its current
 * five-hour window, and its usage since the previous tick. Present only when
 * more than one Claude account is in use, so a single-account snapshot is
 * unchanged (FR-078). The walk's rules apply to each account on its own.
 */

export interface SnapshotAccountWindow {
  name: string;
  usedPercent?: number;
  resetsAt?: string;
  minutesToReset?: number;
  prediction?: ReturnType<typeof projectWindow>;
}

export interface SnapshotAccount {
  account: string;
  label: string;
  where: string;
  employees: string[];
  status: EngineLimitEngineSnapshot["status"];
  stale?: true;
  plan?: string;
  /** No live reading: FR-075a's one probing start applies. */
  noReading?: true;
  hostAsleep?: true;
  exhausted: boolean;
  windows: SnapshotAccountWindow[];
  holdingCapacityNow: number;
  /** Starts on this account since its five-hour window opened (or the last five
   *  hours): a walk start counts on the account its Todo runs on. */
  startedThisWindow: StartCounts & { since: string };
  usageSincePreviousTick?: { previousAt: string; previousUsedPercent: number; usedPercentNow: number; risePoints: number };
}

export interface AccountSnapshotDeps {
  now: number;
  holding: readonly Session[];
  prior?: Record<string, PriorFiveHour>;
  /** The account a session's Claude turns run on. */
  sessionAccount?: (session: Session) => string;
  /** The account a Todo would run on (accounts.ts). */
  todoAccount: (item: { id: string; assignee: string | null }) => string;
  history?: (account: string, sinceMs: number) => UsageSample[];
  createdSince?: (sinceMs: number) => Session[];
}

const defaultSessionAccount = (session: Session): string =>
  session.engine === "claude" ? sessionAccountKey(session.id) ?? DEFAULT_CLAUDE_ACCOUNT : session.engine;

function windowStart(snapshot: EngineLimitEngineSnapshot, now: number): number {
  const fiveHour = snapshot.windows?.find((window) => window.name === "5h");
  return fiveHour?.resetsAt !== undefined && fiveHour.resetsAt * 1000 > now ? fiveHour.resetsAt * 1000 - 300 * 60_000 : now - 5 * 60 * 60_000;
}

/** The account a start counts on: the Todo's for a start the walk made (its
 *  session is the Dispatcher's, on whatever account that runs), else the
 *  session's own. */
export function sessionStartAccount(
  session: Session,
  todoAccount: AccountSnapshotDeps["todoAccount"],
  sessionAccount: (session: Session) => string = defaultSessionAccount,
): string {
  if (startedBy(session) === "board-walk-dispatch") {
    const item = session.workItemId ? getWorkItem(session.workItemId) : undefined;
    const account = item ? todoAccount(item) : UNROUTED;
    return account === UNROUTED ? DEFAULT_CLAUDE_ACCOUNT : account;
  }
  return sessionAccount(session);
}

function startAccount(session: Session, deps: AccountSnapshotDeps): string {
  return sessionStartAccount(session, deps.todoAccount, deps.sessionAccount);
}

export function fiveHourOf(snapshot: EngineLimitEngineSnapshot, now: number): PriorFiveHour | undefined {
  const window = snapshot.windows?.find((entry) => entry.name === "5h");
  if (window?.usedPercent === undefined || window.resetsAt === undefined || window.resetsAt * 1000 <= now) return undefined;
  return { resetsAt: window.resetsAt, usedPercent: window.usedPercent, atMs: now };
}

function accountEntry(reading: EngineLimitAccountSnapshot, deps: AccountSnapshotDeps): SnapshotAccount {
  const { now } = deps;
  const sessionAccount = deps.sessionAccount ?? defaultSessionAccount;
  const since = windowStart(reading, now);
  const history = (deps.history ?? ((account, sinceMs) => readClaudeUsageHistory(sinceMs, usageHistoryPath(account))))(reading.account, now - 7 * 24 * 60 * 60_000);
  const started = (deps.createdSince ?? ((sinceMs) => listSessionsCreatedSince(new Date(sinceMs).toISOString())))(since)
    .filter((session) => !isBoardWalkTurn(session) && startAccount(session, deps) === reading.account)
    .map(toStartedSession);
  const fiveHour = fiveHourOf(reading, now);
  const prior = deps.prior?.[reading.account];
  return {
    account: reading.account,
    label: reading.label,
    where: reading.location.kind === "remote" ? `remote host ${reading.location.host}` : "this host",
    employees: reading.employees,
    status: reading.status,
    ...(reading.stale ? { stale: true as const } : {}),
    ...(reading.accountPlan ? { plan: reading.accountPlan } : {}),
    ...(reading.noReading ? { noReading: true as const } : {}),
    ...(reading.hostUnreachable ? { hostAsleep: true as const } : {}),
    exhausted: reading.exhausted !== undefined,
    windows: (reading.windows ?? []).map((window) => ({
      name: window.name,
      ...(window.usedPercent !== undefined ? { usedPercent: window.usedPercent } : {}),
      ...(window.resetsAt !== undefined ? { resetsAt: new Date(window.resetsAt * 1000).toISOString(), minutesToReset: Math.round((window.resetsAt * 1000 - now) / 60_000) } : {}),
      ...(history.length > 0 ? { prediction: projectWindow(history, window.name, now) } : {}),
    })),
    holdingCapacityNow: deps.holding.filter((session) => sessionAccount(session) === reading.account).length,
    startedThisWindow: { ...countStarts(started), since: new Date(since).toISOString() },
    ...(fiveHour && prior && prior.resetsAt === fiveHour.resetsAt ? {
      usageSincePreviousTick: {
        previousAt: new Date(prior.atMs).toISOString(), previousUsedPercent: prior.usedPercent, usedPercentNow: fiveHour.usedPercent,
        risePoints: Math.round((fiveHour.usedPercent - prior.usedPercent) * 10) / 10,
      },
    } : {}),
  };
}

/** Every Claude account's entry, or undefined with a single account. */
export function snapshotAccounts(readings: EngineLimitAccountSnapshot[] | undefined, deps: AccountSnapshotDeps): SnapshotAccount[] | undefined {
  return readings && readings.length > 1 ? readings.map((reading) => accountEntry(reading, deps)) : undefined;
}

/** After the walk's turn, keep each account's five-hour reading for the next
 *  tick's usage delta, as the default account's is kept. */
export async function recordAccountPriors(
  state: BoardWalkState,
  config: JinnConfig,
  defaultReading: EngineLimitEngineSnapshot,
  now: number,
  collect: typeof collectClaudeAccounts = collectClaudeAccounts,
): Promise<void> {
  const readings = await collect(config, defaultReading).catch(() => undefined);
  if (!readings) {
    delete state.priorFiveHourByAccount;
    return;
  }
  const byAccount: Record<string, PriorFiveHour> = {};
  for (const reading of readings) {
    const fiveHour = reading.account === DEFAULT_CLAUDE_ACCOUNT ? undefined : fiveHourOf(reading, now);
    if (fiveHour) byAccount[reading.account] = fiveHour;
  }
  state.priorFiveHourByAccount = byAccount;
}
