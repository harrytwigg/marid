import type { CronJob, EngineLimitEngineSnapshot, JinnConfig, Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { collectClaudeLimits } from "../shared/engine-limits-claude.js";
import { listSessions, getSession } from "../sessions/registry.js";
import { getWorkItem, type WorkItem } from "../work-items/store.js";
import { startTodoDispatcher, type StartTodoDispatcherResult } from "../gateway/todo-dispatch.js";
import type { ApiContext } from "../gateway/api.js";
import { loadJobs } from "../cron/jobs.js";
import { armedActionJob } from "../cron/scheduler.js";
import { validateCronSchedule } from "../cron/validation.js";
import { readRules, boardWalkPath, hostTimezone, missingDefaultSections, readTemplateRules, withRunnerOverrides, type BoardWalkRules, type BoardWalkSettings } from "./settings.js";
import { findBoardWalkJob } from "./job.js";
import { buildCapacitySnapshot, claudeFiveHour, type SnapshotDeps } from "./snapshot.js";
import { listOpenTodos } from "./board.js";
import { buildPrompt } from "./prompt.js";
import type { StartDecision } from "./decisions.js";
import { stuckEpisode } from "./apply.js";
import { walkCallBudget, WalkTools, type WalkToolResult } from "./turn.js";
import { routeTurn } from "./route-turn.js";
import { listWorkItems } from "../work-items/store.js";
import { cachedResolver, ghResolver, type LinkResolver } from "./pr-state.js";
import { BOARD_WALK_SESSION_KEY_PREFIX, BOARD_WALK_STARTED_BY } from "./started-sessions.js";
import { appendTick, readState, readTicks, writeState, type BoardWalkState, type TickEntry, type TickRecord } from "./store.js";

/**
 * The board walk: one pass over the board that decides what is ready and what
 * to start. It replaces the numeric idle-capacity loop — there is no other
 * timer that starts work. It has no timer of its own either: the `board-walk`
 * cron job (job.ts) fires it, and the cron controls run it now, reschedule it
 * and switch it off.
 *
 * Each tick: read board-walk.md; stop if it is broken; build the capacity
 * snapshot; run one turn as the configured employee, whose only tools are the
 * walk's own (turn.ts): it reads the board through them one Todo at a time
 * and hands over a decision on each, which the gateway checks and carries out
 * as it comes (apply.ts); then log the tick, every decision in it, and the
 * reason when there was nothing to do.
 *
 * Why a model turn and not code, when docs/idle-capacity.md once argued the
 * opposite: the decision is no longer a handful of numeric comparisons. Gates
 * are prose ("after the 10th", "once #18 merges"), and the operator wants to say
 * what they like dispatched and when, in words. One Sonnet turn an hour does
 * both jobs, and on a board with nothing open the tick spends nothing at all.
 */

export interface WalkTurn {
  prompt: string;
  settings: BoardWalkSettings;
  sessionKey: string;
  title: string;
  /** The turn's tools, as the gateway serves them to its session. */
  tools: WalkTools;
}

export interface WalkTurnResult {
  sessionId?: string;
  reply?: string;
  error?: string;
}

export interface BoardWalkDeps {
  getConfig: () => JinnConfig;
  context: ApiContext;
  rulesFile?: string;
  now?: () => number;
  /** Run the model turn. Defaults to a session routed to the configured employee. */
  runTurn?: (turn: WalkTurn) => Promise<WalkTurnResult>;
  /** Start a Todo. Defaults to the Todo Dispatcher, as the dispatch button does. */
  dispatch?: (item: WorkItem, decision: StartDecision) => StartTodoDispatcherResult;
  resolveLink?: LinkResolver;
  sessions?: () => Session[];
  /** Which sessions hold engine capacity now (running, queued or waiting).
   *  Passed in by the server, which owns the transport state it reads. */
  holdingCapacity: (sessions: readonly Session[]) => Session[];
  /** The Claude reading taken after the turn, for the next tick's usage delta. */
  collectClaude?: (config: JinnConfig) => Promise<EngineLimitEngineSnapshot>;
  snapshot?: Partial<Pick<SnapshotDeps, "collect" | "usageHistory" | "statuslineMtime" | "startedSince" | "exhausted">>;
  /** The job the cron scheduler armed for the walk: the one that fires, whose
   *  zone is the walk's "local time". Defaults to the live scheduler's. */
  armedJob?: () => CronJob | undefined;
  /** The walk's job when none is armed (switched off, or not valid), so the
   *  status can still name it. Defaults to the one in cron/jobs.json. */
  scheduleJob?: () => CronJob | undefined;
  /** How long the model turn may take before the tick gives up on it.
   *  Defaults to walkTimeoutMs for the board's size. */
  turnTimeoutMs?: number;
  /** The board's change signal for a Todo the walk started (the dispatch
   *  route's own `dispatched` event). Passed in by the server. */
  emitProjectionEvent?: (workItemId: string, action: string) => void;
  /** Stop the walk's own turn, by its session key, when it times out. */
  stopTurn?: (sessionKey: string) => void;
  /** The shipped rules file, for the sections an operator's file leaves out. */
  templateRules?: () => string;
}

/** How long a tick waits for its turn: long enough to go through a big board
 *  one Todo at a time, never so long that a turn stuck behind a rate-limit
 *  wait holds the walk until the window resets. Ten minutes, plus fifteen
 *  seconds a Todo past the twentieth, up to thirty. */
export function walkTimeoutMs(openTodos: number): number {
  return Math.min(30, 10 + Math.max(0, openTodos - 20) / 4) * 60_000;
}

/** The cron job that schedules the walk, as the status reports it. */
export interface BoardWalkJobStatus {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  /** The job's zone, or the gateway host's when it names none. */
  timezone: string;
}

export interface BoardWalkStatus {
  path: string;
  exists: boolean;
  settings: BoardWalkSettings;
  problems: string[];
  /** Retired schedule keys still in board-walk.md, which are not read. */
  retiredKeys: string[];
  /** The job: the one the scheduler armed, else the one on file; null when
   *  there is none and the walk runs only by hand. */
  job: BoardWalkJobStatus | null;
  /** The cron scheduler has armed a job for the walk, so it fires. */
  scheduled: boolean;
  running: boolean;
  lastTick?: TickRecord;
}

export interface BoardWalk {
  tick: (trigger?: TickRecord["trigger"]) => Promise<TickRecord>;
  status: () => BoardWalkStatus;
  /** One call from a walk tool (gateway/board-walk-api.ts). Answered only for
   *  the running tick's own session. */
  turnTool: (callerSessionId: string, name: string, args: Record<string, unknown>) => Promise<{ status: number; body: WalkToolResult | { error: string } }>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dispatcherSuffix(decision: StartDecision): string {
  const prefer = decision.engine
    ? ` It prefers engine ${decision.engine}${decision.model ? ` (model ${decision.model})` : ""}: route the Todo to an employee on that engine if one fits the work.`
    : "";
  return `The board walk started this Todo. Its reason: ${decision.reason}${prefer}`;
}

function flaggedSet(state: ReturnType<typeof readState>): Set<string> {
  const flagged = new Set<string>();
  for (const [id, episode] of Object.entries(state.stuckFlags)) {
    const item = getWorkItem(id);
    if (item && stuckEpisode(item) === episode) flagged.add(id);
  }
  return flagged;
}

/** Counted by what the gateway did, not by what the model judged: a stuck
 *  verdict left alone, or a release of a Todo already queued, is not an act. */
function summarise(entries: TickEntry[]): string {
  const did = (kind: TickEntry["kind"], outcome: string) => entries.filter((entry) => entry.kind === kind && entry.outcome?.startsWith(outcome)).length;
  const count = (kind: TickEntry["kind"]) => entries.filter((entry) => entry.kind === kind).length;
  const parts: Array<[number, string]> = [
    [did("release", "moved"), "released"], [did("park", "parked"), "parked"], [did("stuck", "flagged"), "flagged stuck"],
    [did("dispatch", "started"), "started"], [count("refused"), "refused"], [count("undecided"), "not decided"],
  ];
  const text = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return text.length > 0 ? text.join(", ") : "nothing to do";
}

/** Every dependency, defaulted. */
interface Walker {
  getConfig: () => JinnConfig;
  now: () => number;
  rulesFile: string;
  resolveLink: LinkResolver;
  runTurn: (turn: WalkTurn) => Promise<WalkTurnResult>;
  sessions: () => Session[];
  holding: (sessions: readonly Session[]) => Session[];
  collectClaude: (config: JinnConfig) => Promise<EngineLimitEngineSnapshot>;
  dispatch: (item: WorkItem, decision: StartDecision) => StartTodoDispatcherResult;
  snapshot: BoardWalkDeps["snapshot"];
  /** Undefined: walkTimeoutMs for the board's size. */
  turnTimeoutMs?: number;
  stopTurn: (sessionKey: string) => void;
  templateRules: () => string;
  armedJob: () => CronJob | undefined;
  scheduleJob: () => CronJob | undefined;
  /** The tick's turn while it runs: its session key, and the tools it may call. */
  active: { sessionKey: string; tools: WalkTools } | null;
}

function defaultDispatch(deps: BoardWalkDeps): Walker["dispatch"] {
  return (item, decision) => startTodoDispatcher(item, deps.context, {
    promptSuffix: dispatcherSuffix(decision),
    transportMeta: { startedBy: BOARD_WALK_STARTED_BY },
    ...(deps.emitProjectionEvent ? { emitProjectionEvent: deps.emitProjectionEvent } : {}),
  });
}

function runtimeDeps(deps: BoardWalkDeps): Pick<Walker, "now" | "rulesFile" | "resolveLink" | "runTurn" | "sessions" | "collectClaude"> {
  return {
    now: deps.now ?? Date.now,
    rulesFile: deps.rulesFile ?? boardWalkPath(),
    resolveLink: deps.resolveLink ?? cachedResolver(ghResolver()),
    runTurn: deps.runTurn ?? routeTurn(deps),
    sessions: deps.sessions ?? (() => listSessions()),
    collectClaude: deps.collectClaude ?? collectClaudeLimits,
  };
}

function walker(deps: BoardWalkDeps): Walker {
  return {
    ...runtimeDeps(deps),
    getConfig: deps.getConfig,
    holding: deps.holdingCapacity,
    dispatch: deps.dispatch ?? defaultDispatch(deps),
    snapshot: deps.snapshot,
    ...(deps.turnTimeoutMs ? { turnTimeoutMs: deps.turnTimeoutMs } : {}),
    stopTurn: deps.stopTurn ?? (() => {}),
    templateRules: deps.templateRules ?? (() => readTemplateRules()),
    armedJob: deps.armedJob ?? (() => armedActionJob("board-walk")),
    scheduleJob: deps.scheduleJob ?? (() => findBoardWalkJob(loadJobs())),
    active: null,
  };
}

/** The job the status describes: the armed one, else the one on file. */
function walkJob(w: Walker): CronJob | undefined {
  return w.armedJob() ?? w.scheduleJob();
}

/** The zone the walk reads "local time" in: its job's, else the host's. A
 *  hand-edited zone that is not valid (the scheduler skips that job) falls
 *  back to the host's too, so a run-now still works. */
function walkTimezone(w: Walker): string {
  const zone = walkJob(w)?.timezone?.trim();
  return zone && validateCronSchedule({ schedule: "0 * * * *", timezone: zone }).length === 0 ? zone : hostTimezone();
}

/** The turn, or a failure once `ms` has passed — when the turn is also
 *  stopped, so a turn parked behind a rate-limit wait does not run on (or
 *  answer) after the tick has given up on it. */
function withTimeout(turn: Promise<WalkTurnResult>, ms: number, stop: () => void): Promise<WalkTurnResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<WalkTurnResult>((resolve) => {
    const span = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
    timer = setTimeout(() => {
      try { stop(); } catch (error) { logger.warn(`Board walk: could not stop the timed-out turn: ${errorText(error)}`); }
      resolve({ error: `the model turn did not finish within ${span}; it was stopped` });
    }, ms);
    timer.unref?.();
  });
  return Promise.race([turn, timeout]).finally(() => clearTimeout(timer));
}

interface TickFrame { w: Walker; trigger: TickRecord["trigger"]; startedAt: number; at: string }

function finish(frame: TickFrame, record: Omit<TickRecord, "at" | "trigger">): TickRecord {
  const done: TickRecord = { at: frame.at, trigger: frame.trigger, ...record, durationMs: frame.w.now() - frame.startedAt };
  appendTick(done);
  const line = `Board walk (${done.trigger}): ${done.outcome} — ${done.summary}`;
  if (done.outcome === "failed" || done.outcome === "invalid-rules") logger.warn(line);
  else logger.info(line);
  return done;
}

/** The reading after the turn is the next tick's reference: the walk's own
 *  spend is then behind it, and is not mistaken for the operator's. */
async function recordClaudeReading(w: Walker, config: JinnConfig, state: BoardWalkState): Promise<void> {
  try {
    const fiveHour = claudeFiveHour(await w.collectClaude(config), w.now());
    if (fiveHour) state.priorFiveHour = fiveHour;
    else delete state.priorFiveHour;
  } catch {
    delete state.priorFiveHour;
  }
}

/** How a tick that ran its turn came out: the turn's failure, if any, beside
 *  every decision the gateway carried out before it. */
function turnRecord(turn: WalkTurnResult, tools: WalkTools): Omit<TickRecord, "at" | "trigger"> {
  const entries = tools.entries();
  const session = turn.sessionId ? { sessionId: turn.sessionId } : {};
  const modelSummary = tools.modelSummary ? { modelSummary: tools.modelSummary } : {};
  if (turn.error) {
    return {
      outcome: "failed",
      summary: `the model turn failed: ${turn.error}${tools.carriedOut > 0 ? ` (before it stopped: ${summarise(entries)})` : ""}`,
      ...modelSummary, ...session,
      entries: [...entries, { kind: "error", reason: turn.error }],
    };
  }
  // A turn that decided nothing and never finished did not walk the board: the
  // likeliest cause is that its tools never reached it. That must not read as
  // a quiet, successful tick.
  if (tools.carriedOut === 0 && !tools.finished) {
    const reason = "the walk's turn decided nothing and did not finish the tick; its tools may not have reached it";
    return { outcome: "failed", summary: reason, ...modelSummary, ...session, entries: [...entries, { kind: "error", reason }] };
  }
  return {
    outcome: "ok",
    summary: `${summarise(entries)}. Dispatch: ${tools.dispatchReason ?? "the walk did not finish the tick, so gave no reason"}`,
    ...modelSummary, ...session,
    entries,
  };
}

/**
 * A turn that carried out nothing and never finished: the signature of the
 * walk's tools not reaching it. The likeliest cause is the engine's MCP server
 * not being connected when the turn ran — a per-process startup race in the
 * Claude Code CLI, whose `tools/list` is answered once and never re-queried, so
 * a turn that starts before its MCP server is ready runs with no tools at all.
 * The model is told about the five tools in the prompt, so with none attached it
 * emits text that looks like calls. A fresh turn is a fresh engine process and
 * re-rolls the race, so the tick retries once rather than losing the hour. Only
 * this signature retries: a turn that failed with an engine error, or that
 * carried out decisions before stopping, is not the tools-never-arrived case.
 */
function toolsNeverArrived(turn: WalkTurnResult, tools: WalkTools): boolean {
  return !turn.error && tools.carriedOut === 0 && !tools.finished;
}

/** One attempt at the walk's turn: a fresh session (a fresh engine process,
 *  which is what re-rolls the MCP startup race) with its own tools. */
async function runAttempt(
  frame: TickFrame,
  rules: BoardWalkRules,
  state: BoardWalkState,
  attempt: { openIds: string[]; prompt: string; suffix: string },
): Promise<{ turn: WalkTurnResult; tools: WalkTools }> {
  const { w, at } = frame;
  const { settings } = rules;
  const { openIds, prompt, suffix } = attempt;
  const maxCalls = walkCallBudget(openIds.length);
  const tools = new WalkTools({
    apply: { settings, state, dispatch: w.dispatch, now: w.now, resolveLink: w.resolveLink },
    flagged: flaggedSet(state),
    openIds,
    maxCalls,
    persist: () => writeState(state),
  });
  const sessionKey = `${BOARD_WALK_SESSION_KEY_PREFIX}${at}${suffix}`;
  w.active = { sessionKey, tools };
  let turn: WalkTurnResult;
  try {
    turn = await withTimeout(
      w.runTurn({ prompt, settings, sessionKey, title: `Board walk ${at.slice(0, 16).replace("T", " ")}`, tools }),
      w.turnTimeoutMs ?? walkTimeoutMs(openIds.length),
      () => w.stopTurn(sessionKey),
    );
  } finally {
    // Nothing a stopped or late turn calls is carried out after this.
    tools.close();
    w.active = null;
  }
  return { turn, tools };
}

/** Run the walk's turn: the model goes through the board with its tools, and
 *  the gateway carries out each decision as it is made. */
async function walkBoard(frame: TickFrame, rules: BoardWalkRules, state: BoardWalkState, openIds: string[]): Promise<TickRecord> {
  const { w, startedAt } = frame;
  const { settings } = rules;
  const config = w.getConfig();
  const snapshot = await buildCapacitySnapshot({
    config, timezone: walkTimezone(w), now: startedAt, sessions: w.sessions(), holdingCapacity: w.holding,
    ...(state.priorFiveHour ? { prior: state.priorFiveHour } : {}),
    ...w.snapshot,
  });
  const maxCalls = walkCallBudget(openIds.length);
  const prompt = buildPrompt({
    settings, rules: rules.body, defaults: missingDefaultSections(rules.body, w.templateRules()), snapshot,
    board: { open: openIds.length, inReview: listWorkItems({ status: "in_review" }).length }, maxCalls,
  });
  let attempt = await runAttempt(frame, rules, state, { openIds, prompt, suffix: "" });
  if (toolsNeverArrived(attempt.turn, attempt.tools)) {
    logger.warn(`Board walk: the turn carried out nothing and never finished (the walk's tools may not have reached it); retrying once on a fresh turn`);
    attempt = await runAttempt(frame, rules, state, { openIds, prompt, suffix: ":retry" });
  }
  await recordClaudeReading(w, config, state);
  return finish(frame, turnRecord(attempt.turn, attempt.tools));
}

async function evaluate(w: Walker, trigger: TickRecord["trigger"]): Promise<TickRecord> {
  const startedAt = w.now();
  const frame: TickFrame = { w, trigger, startedAt, at: new Date(startedAt).toISOString() };
  const rules = resolvedRules(w);
  if (!rules.exists || rules.problems.length > 0) {
    const reason = rules.problems.join("; ");
    return finish(frame, { outcome: "invalid-rules", summary: reason, entries: [{ kind: "error", reason }] });
  }
  const state = readState();
  const openIds = listOpenTodos().map((item) => item.id);
  if (openIds.length === 0) {
    return finish(frame, { outcome: "ok", summary: "nothing to do: the board has no open Todos", entries: [{ kind: "nothing", reason: "the board has no open Todos; no model turn was spent" }] });
  }
  try {
    return await walkBoard(frame, rules, state, openIds);
  } finally {
    writeState(state);
  }
}

function jobStatus(job: CronJob | undefined): BoardWalkJobStatus | null {
  if (!job) return null;
  return { id: job.id, name: job.name, enabled: job.enabled, schedule: job.schedule, timezone: job.timezone?.trim() || hostTimezone() };
}

/** The rules file's settings with the cron job's runner fields on top: the job
 *  (`walkJob`) is the object the cron controls edit, so where it sets one it
 *  wins over the file; absent on both, the shipped defaults stand. */
function resolvedRules(w: Walker): BoardWalkRules {
  const base = readRules(w.rulesFile);
  return { ...base, settings: withRunnerOverrides(base.settings, walkJob(w)) };
}

export function startBoardWalk(deps: BoardWalkDeps): BoardWalk {
  const w = walker(deps);
  let inFlight: Promise<TickRecord> | null = null;

  // One tick at a time: a scheduled fire that lands mid-tick is logged and
  // dropped, never stacked, and answers with its own skipped record so its
  // cron run says so; a manual tick joins the one running.
  const tick = (trigger: TickRecord["trigger"] = "manual"): Promise<TickRecord> => {
    if (inFlight) {
      if (trigger !== "schedule") return inFlight;
      const skipped: TickRecord = { at: new Date(w.now()).toISOString(), trigger, outcome: "busy", summary: "the previous tick is still running; this one was skipped", entries: [] };
      appendTick(skipped);
      return Promise.resolve(skipped);
    }
    inFlight = evaluate(w, trigger)
      .catch((error) => {
        const record: TickRecord = { at: new Date(w.now()).toISOString(), trigger, outcome: "failed", summary: `the tick crashed: ${errorText(error)}`, entries: [{ kind: "error", reason: errorText(error) }] };
        appendTick(record);
        logger.warn(`Board walk tick failed: ${errorText(error)}`);
        return record;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  const turnTool: BoardWalk["turnTool"] = async (callerSessionId, name, args) => {
    const active = w.active;
    if (!active) return { status: 409, body: { error: "no board walk turn is running" } };
    // The session key is minted per tick and only the walk's own turn runs
    // under it: no other session, however it is bound, reaches these tools.
    if (getSession(callerSessionId)?.sessionKey !== active.sessionKey) {
      return { status: 403, body: { error: "only the running board walk's own turn may use the walk's tools" } };
    }
    return { status: 200, body: await active.tools.call(name, args) };
  };

  return {
    tick,
    turnTool,
    status: () => {
      const rules = resolvedRules(w);
      const last = readTicks(1)[0];
      const armed = w.armedJob();
      return {
        path: w.rulesFile, exists: rules.exists, settings: rules.settings, problems: rules.problems, retiredKeys: rules.retiredKeys,
        job: jobStatus(armed ?? w.scheduleJob()), scheduled: armed !== undefined, running: inFlight !== null, ...(last ? { lastTick: last } : {}),
      };
    },
  };
}
