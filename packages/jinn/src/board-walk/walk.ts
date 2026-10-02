import cron from "node-cron";
import type { Employee, EngineLimitEngineSnapshot, JinnConfig, Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { collectClaudeLimits } from "../shared/engine-limits-claude.js";
import { isEngineExhausted, readEngineHealth } from "../shared/engine-health.js";
import { engineAvailable } from "../shared/models.js";
import { listSessions, getMessages, getSession } from "../sessions/registry.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { CronConnector } from "../connectors/cron/index.js";
import { getWorkItem, type WorkItem } from "../work-items/store.js";
import { startTodoDispatcher, type StartTodoDispatcherResult } from "../gateway/todo-dispatch.js";
import type { ApiContext } from "../gateway/api.js";
import { readRules, boardWalkPath, missingDefaultSections, readTemplateRules, type BoardWalkRules, type BoardWalkSettings } from "./settings.js";
import { buildCapacitySnapshot, claudeFiveHour, type SnapshotDeps } from "./snapshot.js";
import { buildBoardDigest, type BoardDigest } from "./board.js";
import { buildPrompt } from "./prompt.js";
import { parseDecisions, type StartDecision } from "./decisions.js";
import { applyDecisions, stuckEpisode } from "./apply.js";
import { cachedResolver, ghResolver, type LinkResolver } from "./pr-state.js";
import { BOARD_WALK_SESSION_KEY_PREFIX, BOARD_WALK_STARTED_BY } from "./started-sessions.js";
import { appendTick, readState, readTicks, writeState, type BoardWalkState, type TickEntry, type TickRecord } from "./store.js";

/**
 * The board walk: one scheduled pass over the board that decides what is ready
 * and what to start. It replaces the numeric idle-capacity loop — there is no
 * other timer that starts work.
 *
 * Each tick: read board-walk.md; stop if it is switched off or broken; build the
 * capacity snapshot and the board digest; ask the configured employee's engine
 * for one structured answer (one turn, no tool calls); carry the answer out
 * through apply.ts; log the tick, every decision in it, and the reason when
 * there was nothing to do.
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
  /** Re-read the rules file this often to pick up schedule changes. */
  pollMs?: number;
  /** How long the model turn may take before the tick gives up on it. */
  turnTimeoutMs?: number;
  /** The board's change signal for a Todo the walk started (the dispatch
   *  route's own `dispatched` event). Passed in by the server. */
  emitProjectionEvent?: (workItemId: string, action: string) => void;
  /** Stop the walk's own turn, by its session key, when it times out. */
  stopTurn?: (sessionKey: string) => void;
  /** The shipped rules file, for the sections an operator's file leaves out. */
  templateRules?: () => string;
}

/** Long enough for a slow turn on a big board; short enough that a turn stuck
 *  behind a rate-limit wait does not hold the walk until the window resets. */
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

export interface BoardWalkStatus {
  path: string;
  exists: boolean;
  settings: BoardWalkSettings;
  problems: string[];
  scheduled: boolean;
  running: boolean;
  lastTick?: TickRecord;
}

export interface BoardWalk {
  tick: (trigger?: TickRecord["trigger"]) => Promise<TickRecord>;
  status: () => BoardWalkStatus;
  stop: () => void;
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

/**
 * The employee the walk's turn runs as: the configured one, on Claude, with
 * every tool taken away. The walk decides; the gateway acts. A tool call in
 * this turn would be an act nobody checked, so:
 *   - every MCP server, the Jinn toolset included, is detached;
 *   - Claude's built-in tools are switched off (`--tools ""`), no other MCP
 *     configuration is read (`--strict-mcp-config`), and the Chrome
 *     integration the engine always enables is switched off again
 *     (`--no-chrome`), which otherwise brings its browser tools back;
 *   - the turn always runs on Claude, on the gateway, whatever engine or host
 *     the employee normally uses. Claude is the one engine whose tools can be
 *     switched off from the command line; opencode in server mode ignores those
 *     flags, so a walk on it would keep its shell. The employee's own flags are
 *     dropped for the same reason: they were written for its own engine.
 * The rate-limit handler never hands a walk turn to a fallback engine either
 * (rate-limit-handler.ts); a limited walk waits, and the walk's timeout stops it.
 */
export const WALK_ENGINE = "claude";

/** `claudeModel` stands in for the employee's own model when that model
 *  belongs to another engine. */
export function lockedDownEmployee(employee: Employee, claudeModel: string): Employee {
  const { remoteHost: _host, remoteUser: _user, remoteCwd: _cwd, ...local } = employee;
  return {
    ...local,
    engine: WALK_ENGINE,
    model: employee.engine === WALK_ENGINE ? employee.model : claudeModel,
    mcp: false,
    jinnMcp: false,
    // `--no-chrome` must come after the engine's own `--chrome` (it does:
    // employee flags are appended), or the browser tools come back.
    cliFlags: ["--no-chrome", "--tools", "", "--strict-mcp-config"],
  };
}

/** The default turn: a session routed to the rules file's employee, read back
 *  from the registry once the turn settles. */
function routeTurn(deps: BoardWalkDeps): (turn: WalkTurn) => Promise<WalkTurnResult> {
  return async (turn) => {
    const config = deps.getConfig();
    const configured = orgRegistry(config).get(turn.settings.employee);
    if (!configured) return { error: `employee ${turn.settings.employee} named in board-walk.md does not exist` };
    const employee = lockedDownEmployee(configured, config.engines.claude?.model ?? "sonnet");
    // The pinned engine and named model skip the session layer's healthy-engine
    // choice, so check here rather than walk into a spent window and wait.
    if (!engineAvailable(config, WALK_ENGINE)) return { error: "the board walk runs on Claude so that its turn has no tools, and Claude is not installed" };
    if (isEngineExhausted(readEngineHealth(), WALK_ENGINE)) return { error: "Claude is recorded as exhausted; this tick is skipped" };
    const connector = new CronConnector(new Map());
    const routed = await deps.context.sessionManager.route(
      {
        connector: connector.name,
        source: "cron",
        sessionKey: turn.sessionKey,
        replyContext: { channel: "board-walk", messageTs: null },
        messageId: undefined,
        channel: "board-walk",
        thread: undefined,
        user: "system",
        userId: "system",
        text: turn.prompt,
        attachments: [],
        raw: { trigger: "board-walk" },
        transportMeta: { boardWalk: true },
      },
      connector,
      { employee, engine: WALK_ENGINE, ...(turn.settings.model ? { model: turn.settings.model } : {}), title: turn.title },
    );
    return routed?.sessionId ? settledTurn(routed.sessionId) : { error: "the walk's session was not started" };
  };
}

/** Why a settled walk session failed, or undefined when it did not. */
function turnFailure(sessionId: string): string | undefined {
  const settled = getSession(sessionId);
  if (!settled) return undefined;
  const outcome = settled.attemptOutcome === "failed" || settled.attemptOutcome === "interrupted" ? settled.attemptOutcome : undefined;
  if (!outcome && settled.status !== "error") return undefined;
  return settled.lastError ?? `the walk's turn ${outcome ?? settled.status}`;
}

/** What a settled walk session came to: its reply, or why there is none. */
function settledTurn(sessionId: string): WalkTurnResult {
  const failure = turnFailure(sessionId);
  if (failure) return { sessionId, error: failure };
  const reply = [...getMessages(sessionId)].reverse().find((message) => message.role === "assistant" && !message.partial)?.content;
  return reply ? { sessionId, reply } : { sessionId, error: "the walk's turn produced no reply" };
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
  const parts: Array<[number, string]> = [
    [did("release", "moved"), "released"], [did("park", "parked"), "parked"], [did("stuck", "flagged"), "flagged stuck"],
    [did("dispatch", "started"), "started"], [entries.filter((entry) => entry.kind === "refused").length, "refused"],
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
  turnTimeoutMs: number;
  stopTurn: (sessionKey: string) => void;
  templateRules: () => string;
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
    turnTimeoutMs: deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    stopTurn: deps.stopTurn ?? (() => {}),
    templateRules: deps.templateRules ?? (() => readTemplateRules()),
  };
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

/** Ask the model and carry out its answer. */
async function walkBoard(frame: TickFrame, rules: BoardWalkRules, state: BoardWalkState, board: BoardDigest): Promise<TickRecord> {
  const { w, at, startedAt } = frame;
  const { settings } = rules;
  const config = w.getConfig();
  const snapshot = await buildCapacitySnapshot({
    config, timezone: settings.timezone, now: startedAt, sessions: w.sessions(), holdingCapacity: w.holding,
    ...(state.priorFiveHour ? { prior: state.priorFiveHour } : {}),
    ...w.snapshot,
  });
  const prompt = buildPrompt({ settings, rules: rules.body, defaults: missingDefaultSections(rules.body, w.templateRules()), snapshot, board });
  const sessionKey = `${BOARD_WALK_SESSION_KEY_PREFIX}${at}`;
  const turn = await withTimeout(
    w.runTurn({ prompt, settings, sessionKey, title: `Board walk ${at.slice(0, 16).replace("T", " ")}` }),
    w.turnTimeoutMs,
    () => w.stopTurn(sessionKey),
  );
  await recordClaudeReading(w, config, state);

  const session = turn.sessionId ? { sessionId: turn.sessionId } : {};
  if (turn.error || !turn.reply) {
    const reason = turn.error ?? "no reply";
    return finish(frame, { outcome: "failed", summary: `the model turn failed: ${reason}`, ...session, entries: [{ kind: "error", reason }] });
  }
  const parsed = parseDecisions(turn.reply);
  if (!parsed.ok) {
    return finish(frame, { outcome: "failed", summary: `the answer could not be used: ${parsed.error}`, ...session, entries: [{ kind: "error", reason: parsed.error }] });
  }
  const entries = [
    ...parsed.problems.map((problem): TickEntry => ({ kind: "refused", reason: problem, outcome: "unreadable decision, ignored" })),
    ...await applyDecisions({ settings, state, dispatch: w.dispatch, now: w.now, resolveLink: w.resolveLink }, parsed.decisions),
  ];
  return finish(frame, {
    outcome: "ok",
    summary: `${summarise(entries)}. Dispatch: ${parsed.decisions.dispatch.reason}`,
    modelSummary: parsed.decisions.summary,
    ...session,
    entries,
  });
}

async function evaluate(w: Walker, trigger: TickRecord["trigger"]): Promise<TickRecord> {
  const startedAt = w.now();
  const frame: TickFrame = { w, trigger, startedAt, at: new Date(startedAt).toISOString() };
  const rules = readRules(w.rulesFile);
  if (!rules.exists || rules.problems.length > 0) {
    const reason = rules.problems.join("; ");
    return finish(frame, { outcome: "invalid-rules", summary: reason, entries: [{ kind: "error", reason }] });
  }
  if (!rules.settings.enabled) {
    return finish(frame, { outcome: "disabled", summary: "the board walk is switched off (enabled: false)", entries: [] });
  }
  const state = readState();
  const board = await buildBoardDigest({ resolveLink: w.resolveLink, flagged: flaggedSet(state) });
  if (board.todos.length === 0) {
    return finish(frame, { outcome: "ok", summary: "nothing to do: the board has no open Todos", entries: [{ kind: "nothing", reason: "the board has no open Todos; no model turn was spent" }] });
  }
  try {
    return await walkBoard(frame, rules, state, board);
  } finally {
    writeState(state);
  }
}

/** The schedule follows the file: re-read on a poll, re-armed only when the
 *  schedule, zone or switch changed. Disabled means no task at all. */
function scheduler(rulesFile: string, fire: () => void, pollMs: number): { scheduled: () => boolean; stop: () => void } {
  let task: cron.ScheduledTask | null = null;
  let armed = "";
  const arm = (): void => {
    const rules = readRules(rulesFile);
    const { settings } = rules;
    const scheduleProblem = rules.problems.some((problem) => problem.startsWith("schedule") || problem.startsWith("timezone"));
    const key = rules.exists && settings.enabled && !scheduleProblem ? `${settings.schedule}|${settings.timezone}` : "";
    if (key === armed) return;
    task?.stop();
    task = null;
    armed = key;
    if (!key) {
      logger.info(rules.problems.length > 0 ? `Board walk not scheduled: ${rules.problems.join("; ")}` : "Board walk not scheduled: switched off in board-walk.md");
      return;
    }
    task = cron.schedule(settings.schedule, fire, { timezone: settings.timezone, scheduled: false });
    task.start();
    logger.info(`Board walk scheduled: ${settings.schedule} (${settings.timezone})`);
  };
  arm();
  const poll = setInterval(arm, pollMs);
  poll.unref?.();
  return {
    scheduled: () => task !== null,
    stop: () => { clearInterval(poll); task?.stop(); task = null; },
  };
}

export function startBoardWalk(deps: BoardWalkDeps): BoardWalk {
  const w = walker(deps);
  let inFlight: Promise<TickRecord> | null = null;

  // One tick at a time: a scheduled fire that lands mid-tick is logged and
  // dropped, never stacked; a manual tick joins the one running.
  const tick = (trigger: TickRecord["trigger"] = "manual"): Promise<TickRecord> => {
    if (inFlight) {
      if (trigger === "schedule") appendTick({ at: new Date(w.now()).toISOString(), trigger, outcome: "busy", summary: "the previous tick is still running; this one was skipped", entries: [] });
      return inFlight;
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

  const schedule = scheduler(w.rulesFile, () => { void tick("schedule"); }, deps.pollMs ?? 60_000);
  return {
    tick,
    status: () => {
      const rules = readRules(w.rulesFile);
      const last = readTicks(1)[0];
      return {
        path: w.rulesFile, exists: rules.exists, settings: rules.settings, problems: rules.problems,
        scheduled: schedule.scheduled(), running: inFlight !== null, ...(last ? { lastTick: last } : {}),
      };
    },
    stop: schedule.stop,
  };
}
