import type { JinnConfig, EngineLimitEngineSnapshot } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { collectClaudeLimits } from "../shared/engine-limits-claude.js";
import { isEngineExhausted, readEngineHealth } from "../shared/engine-health.js";
import { engineAvailable } from "../shared/models.js";
import {
  evaluateIdleCapacity,
  fiveHourReading,
  isQuietHour,
  resolveIdleCapacityPolicy,
  selectTier,
  type IdleCapacityPolicy,
  type IdleCapacityTier,
  type IdleCapacityVerdict,
} from "../shared/idle-capacity.js";
import { IDLE_CAPACITY_ACTOR, formatStartNote, type IdleCapacityStartRecord } from "../shared/idle-capacity-record.js";
import type { WorkItem } from "../work-items/store.js";
import { addComment } from "../work-items/comment-add.js";
import { listSessions } from "../sessions/registry.js";
import { emitTodoProjectionEvent, sessionsHoldingEngineCapacity, type ApiContext } from "./api.js";
import { startTodoDispatcher, type StartTodoDispatcherResult } from "./todo-dispatch.js";
import { eligibleBacklog, type Skipped } from "./idle-capacity-backlog.js";
import { jinnActiveSince, newestOperatorSessionActivity, newestStatuslineMtime, OperatorActivity, type OperatorSighting } from "./idle-capacity-operator.js";

/**
 * Idle-capacity auto-start: the timer that turns unused Claude
 * allowance into started backlog work. Spec: specs/002-idle-capacity-auto-start.
 *
 * This is deliberately a gateway loop and not a cron job. A cron job is a
 * prompt run by an engine, so an LLM would be spending Claude capacity to
 * decide whether Claude capacity is going spare — on the very window it is
 * measuring — to answer a question that is a handful of numeric comparisons.
 * The loop reads the collector the Limits page already uses, decides in
 * shared/idle-capacity.ts, and starts the same Todo Dispatcher the dispatch
 * button starts. The Dispatcher (one Sonnet turn) is where judgement is
 * needed: which employee or Workflow should own the Todo.
 *
 * Every tick, in order:
 *   1. the feature is off unless config says otherwise;
 *   2. Claude must be installed and not already recorded as exhausted;
 *   3. the account is read, and from it and the clock the tier is chosen —
 *      interactive if the operator is live, overnight in the quiet hours,
 *      daytime otherwise (idle-capacity-operator.ts says what "live" means);
 *   4. capacity must be idle for that tier — no more sessions holding engine
 *      capacity than the tier allows;
 *   5. the reading must say a window is about to lapse under the tier's
 *      ceilings — a gate on starting, re-read every tick, not a bound on what
 *      a started session then consumes;
 *   6. at most the tier's `maxDispatchesPerWindow` starts per five-hour
 *      window, and one Todo per tick, so the next tick sees what this one did.
 */

export { IDLE_CAPACITY_ACTOR };

/** Appended to the Dispatcher's prompt so the routing serves the start's
 *  purpose: the allowance being used is Claude's. */
const DISPATCHER_PURPOSE = [
  "This Todo was started by the idle-capacity auto-start to use Claude allowance that would otherwise lapse.",
  "Prefer an employee whose engine is claude; route it to an employee on another engine only if no Claude-engine employee fits the work.",
].join(" ");

export interface IdleCapacityDeps {
  getConfig: () => JinnConfig;
  context: ApiContext;
  /** Injectable for tests; defaults to the real Claude collector. */
  collect?: (config: JinnConfig) => Promise<EngineLimitEngineSnapshot>;
  /** Injectable for tests; defaults to counting live sessions holding capacity. */
  activeSessions?: () => number;
  /** Injectable for tests; defaults to "any session active since". */
  jinnActiveSince?: (sinceMs: number) => boolean;
  /** Injectable for tests; defaults to the newest Claude statusline snapshot. */
  interactiveActivityAt?: () => number | undefined;
  /** Injectable for tests; defaults to the newest activity on an operator-driven session. */
  operatorSessionActivityAt?: () => number | undefined;
  dispatch?: (item: WorkItem, context: ApiContext) => StartTodoDispatcherResult;
  now?: () => number;
}

export interface IdleCapacityTickResult {
  policy: IdleCapacityPolicy;
  tier: IdleCapacityTier;
  /** Why nothing was started, or why one was. */
  reason: string;
  verdict?: IdleCapacityVerdict;
  started?: { workItemId: string; sessionId: string };
  /** Todos the tick considered and passed over, with why. */
  skipped: Skipped[];
}

export interface IdleCapacityPreview extends Omit<IdleCapacityTickResult, "started"> {
  /** Eligible backlog Todos in the order a tick would try them. */
  eligible: Array<{ workItemId: string; title: string; priority: number }>;
  /** Starts charged to the five-hour window of the latest usable reading. */
  startedThisWindow: number;
  /** The evidence behind the tier: whether the operator is live and why, and
   *  whether the clock is inside the quiet hours. */
  operator: OperatorSighting & { live: boolean };
  quietHours: boolean;
}

export interface IdleCapacityAutoStart {
  /** Run one evaluation now, outside the timer. */
  tick: () => Promise<IdleCapacityTickResult>;
  /** The same evaluation with the start left out: what the next tick would do
   *  and why, with the backlog it would choose from. For the operator. */
  preview: () => Promise<IdleCapacityPreview>;
  stop: () => void;
}

/** Starts charged to a five-hour window, keyed by that window's reset time —
 *  the one identity every reading of the window shares. A restart forgets
 *  this, which errs towards a second start in the same window; the live
 *  ceiling check still stands between that and an overrun. */
interface WindowLedger { resetsAt: number; started: number }

interface LoopState {
  deps: Required<Pick<IdleCapacityDeps, "collect" | "dispatch" | "activeSessions" | "now">> & Pick<IdleCapacityDeps, "getConfig" | "context">;
  operator: OperatorActivity;
  ledger: WindowLedger | undefined;
}

function chargedTo(state: LoopState, resetsAt: number): number {
  return state.ledger?.resetsAt === resetsAt ? state.ledger.started : 0;
}

interface Guarded {
  policy: IdleCapacityPolicy;
  tier: IdleCapacityTier;
  verdict?: IdleCapacityVerdict;
  hold?: string;
  operatorLive: boolean;
}

/** The guards, in order, up to the point of choosing a Todo. Shared by the
 *  tick and the preview so the operator's "why not" is the tick's own — except
 *  that only the tick folds the reading into the operator detector: a preview
 *  that did would shorten the interval the next delta is measured over. */
async function guard(state: LoopState, mode: "tick" | "preview"): Promise<Guarded> {
  const { deps } = state;
  const config = deps.getConfig();
  const policy = resolveIdleCapacityPolicy(config.gateway.idleCapacity);
  const now = deps.now();
  const held = (hold: string, tier: IdleCapacityTier, operatorLive: boolean, verdict?: IdleCapacityVerdict): Guarded =>
    ({ policy, tier, hold, operatorLive, ...(verdict ? { verdict } : {}) });
  const tierNow = (): IdleCapacityTier => selectTier({ nowMs: now, operatorActive: state.operator.isLive(policy, now) }, policy);

  if (!policy.enabled) return held("disabled", tierNow(), state.operator.isLive(policy, now));
  if (!engineAvailable(config, "claude")) return held("Claude CLI is not installed", tierNow(), state.operator.isLive(policy, now));
  if (isEngineExhausted(readEngineHealth(), "claude", new Date(now))) {
    return held("Claude is recorded as exhausted", tierNow(), state.operator.isLive(policy, now));
  }

  // The reading comes first: it is both the verdict's input and one of the
  // two signs of the operator, so the tier is chosen from it.
  const snapshot = await deps.collect(config);
  const operatorLive = mode === "tick"
    ? state.operator.observe(fiveHourReading(snapshot, now), policy, now)
    : state.operator.isLive(policy, now);
  const tier = selectTier({ nowMs: now, operatorActive: operatorLive }, policy);
  const rules = policy.tiers[tier];

  const active = deps.activeSessions();
  if (active >= rules.maxActiveSessions) {
    return held(`${active} session(s) already hold engine capacity (${tier} tier allows fewer than ${rules.maxActiveSessions})`, tier, operatorLive);
  }
  const verdict = evaluateIdleCapacity(snapshot, tier, policy, now);
  if (!verdict.act) return held(verdict.reason, tier, operatorLive, verdict);

  const charged = chargedTo(state, verdict.fiveHour.resetsAt);
  if (charged >= rules.maxDispatchesPerWindow) {
    return held(`${charged} Todo(s) already started in this five-hour window (${tier} tier cap ${rules.maxDispatchesPerWindow})`, tier, operatorLive, verdict);
  }
  return { policy, tier, verdict, operatorLive };
}

/** The comment is the only durable record of a start — the Auto-Dispatch
 *  page's history is parsed back out of it — so its wording is owned by
 *  shared/idle-capacity-record.ts, beside the parser. */
function recordStart(item: WorkItem, record: IdleCapacityStartRecord): void {
  try {
    addComment({ workItemId: item.id, body: formatStartNote(record), author: IDLE_CAPACITY_ACTOR, authorKind: "system" });
  } catch (error) {
    logger.warn(`Idle-capacity: comment on ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  logger.info(`Idle-capacity: started ${item.id} (${record.sessionId}) — ${record.verdict.reason}`);
}

/** Try the eligible Todos in order until one starts. A refusal (claimed,
 *  skills gone, engine down) is reported against that Todo and the next is
 *  tried; a Dispatcher already holding one is not a second start. */
function startFirst(state: LoopState, guarded: Guarded, eligible: WorkItem[], skipped: Skipped[]): IdleCapacityTickResult["started"] {
  const verdict = guarded.verdict;
  if (!verdict?.act) return undefined;
  for (const item of eligible) {
    const started = state.deps.dispatch(item, state.deps.context);
    if (!started.ok) { skipped.push({ workItemId: item.id, reason: started.body.error }); continue; }
    if (started.body.reused) { skipped.push({ workItemId: item.id, reason: "a Dispatcher already holds it" }); continue; }
    const charged = chargedTo(state, verdict.fiveHour.resetsAt) + 1;
    state.ledger = { resetsAt: verdict.fiveHour.resetsAt, started: charged };
    recordStart(item, { verdict, sessionId: started.body.sessionId, charged, cap: guarded.policy.tiers[guarded.tier].maxDispatchesPerWindow });
    return { workItemId: item.id, sessionId: started.body.sessionId };
  }
  return undefined;
}

async function evaluate(state: LoopState): Promise<IdleCapacityTickResult> {
  const guarded = await guard(state, "tick");
  const { policy, tier, verdict, hold } = guarded;
  if (hold) return { policy, tier, reason: hold, ...(verdict ? { verdict } : {}), skipped: [] };

  const { eligible, skipped } = eligibleBacklog(policy);
  const started = startFirst(state, guarded, eligible, skipped);
  if (started) return { policy, tier, reason: `started ${started.workItemId}`, verdict, started, skipped };
  const reason = eligible.length === 0 && skipped.length === 0 ? "the backlog is empty" : "no eligible backlog Todo";
  return { policy, tier, reason, verdict, skipped };
}

async function preview(state: LoopState): Promise<IdleCapacityPreview> {
  const { policy, tier, verdict, hold, operatorLive } = await guard(state, "preview");
  const now = state.deps.now();
  const backlog = policy.enabled ? eligibleBacklog(policy) : { eligible: [], skipped: [] };
  const eligible = backlog.eligible.map((item) => ({ workItemId: item.id, title: item.title, priority: item.priority }));
  const reason = hold ?? (eligible.length === 0 ? "no eligible backlog Todo" : `would start ${eligible[0].workItemId}`);
  return {
    policy, tier, reason,
    ...(verdict ? { verdict } : {}),
    skipped: backlog.skipped,
    eligible,
    startedThisWindow: verdict?.fiveHour ? chargedTo(state, verdict.fiveHour.resetsAt) : state.ledger?.started ?? 0,
    operator: { ...state.operator.lastSighting(), live: operatorLive },
    quietHours: isQuietHour(now, policy),
  };
}

function loopState(deps: IdleCapacityDeps): LoopState {
  return {
    deps: {
      getConfig: deps.getConfig,
      context: deps.context,
      collect: deps.collect ?? collectClaudeLimits,
      dispatch: deps.dispatch ?? ((item, context) => startTodoDispatcher(item, context, {
        promptSuffix: DISPATCHER_PURPOSE,
        emitProjectionEvent: (id, action) => emitTodoProjectionEvent(context, id, action),
      })),
      activeSessions: deps.activeSessions ?? (() => sessionsHoldingEngineCapacity(listSessions(), deps.context).length),
      now: deps.now ?? Date.now,
    },
    operator: new OperatorActivity({
      operatorSessionActivityAt: deps.operatorSessionActivityAt ?? (() => newestOperatorSessionActivity(listSessions())),
      interactiveActivityAt: deps.interactiveActivityAt ?? (() => newestStatuslineMtime()),
      jinnActiveSince: deps.jinnActiveSince ?? ((sinceMs) => jinnActiveSince(listSessions(), sinceMs, (sessions) => sessionsHoldingEngineCapacity(sessions, deps.context).length > 0)),
    }),
    ledger: undefined,
  };
}

export function startIdleCapacityAutoStart(deps: IdleCapacityDeps): IdleCapacityAutoStart {
  const state = loopState(deps);

  // A slow collector must never stack ticks; a tick asked for mid-tick joins it.
  let inFlight: Promise<IdleCapacityTickResult> | null = null;
  const tick = (): Promise<IdleCapacityTickResult> => {
    if (inFlight) return inFlight;
    inFlight = evaluate(state)
      .catch((error) => {
        logger.warn(`Idle-capacity tick failed: ${error instanceof Error ? error.message : String(error)}`);
        const policy = resolveIdleCapacityPolicy(deps.getConfig().gateway.idleCapacity);
        return { policy, tier: "daytime" as const, reason: "tick failed", skipped: [] };
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  // The interval is read at each fire rather than fixed at boot, so a config
  // reload that changes the cadence — or switches the feature on — is
  // respected without a restart. Unref'd: a background loop must never be the
  // reason the process stays up.
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const schedule = (): void => {
    if (stopped) return;
    const minutes = resolveIdleCapacityPolicy(deps.getConfig().gateway.idleCapacity).intervalMinutes;
    timer = setTimeout(() => { void tick().finally(schedule); }, minutes * 60_000);
    timer.unref?.();
  };
  schedule();

  return {
    tick,
    preview: () => preview(state),
    stop: () => { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
