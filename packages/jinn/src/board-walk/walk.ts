import cron from "node-cron";
import type { EngineLimitEngineSnapshot, JinnConfig, Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { collectClaudeLimits } from "../shared/engine-limits-claude.js";
import { listSessions, getMessages, getSession } from "../sessions/registry.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { CronConnector } from "../connectors/cron/index.js";
import { getWorkItem, type WorkItem } from "../work-items/store.js";
import { startTodoDispatcher, type StartTodoDispatcherResult } from "../gateway/todo-dispatch.js";
import type { ApiContext } from "../gateway/api.js";
import { readRules, boardWalkPath, type BoardWalkRules, type BoardWalkSettings } from "./settings.js";
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
}

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

/** The default turn: a session routed to the rules file's employee, read back
 *  from the registry once the turn settles. */
function routeTurn(deps: BoardWalkDeps): (turn: WalkTurn) => Promise<WalkTurnResult> {
  return async (turn) => {
    const config = deps.getConfig();
    const employee = orgRegistry(config).get(turn.settings.employee);
    if (!employee) return { error: `employee ${turn.settings.employee} named in board-walk.md does not exist` };
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
      { employee, ...(turn.settings.model ? { model: turn.settings.model } : {}), title: turn.title },
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

function summarise(entries: TickEntry[]): string {
  const count = (kind: TickEntry["kind"]) => entries.filter((entry) => entry.kind === kind && !entry.outcome?.startsWith("already")).length;
  const parts = [
    [count("release"), "released"], [count("park"), "parked"], [count("stuck"), "flagged stuck"],
    [entries.filter((entry) => entry.kind === "dispatch").length, "started"], [count("refused"), "refused"],
  ].filter(([n]) => (n as number) > 0).map(([n, label]) => `${n} ${label}`);
  return parts.length > 0 ? parts.join(", ") : "nothing to do";
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
}

function walker(deps: BoardWalkDeps): Walker {
  return {
    getConfig: deps.getConfig,
    now: deps.now ?? Date.now,
    rulesFile: deps.rulesFile ?? boardWalkPath(),
    resolveLink: deps.resolveLink ?? cachedResolver(ghResolver()),
    runTurn: deps.runTurn ?? routeTurn(deps),
    sessions: deps.sessions ?? (() => listSessions()),
    holding: deps.holdingCapacity,
    collectClaude: deps.collectClaude ?? collectClaudeLimits,
    dispatch: deps.dispatch ?? ((item, decision) => startTodoDispatcher(item, deps.context, {
      promptSuffix: dispatcherSuffix(decision),
      transportMeta: { startedBy: BOARD_WALK_STARTED_BY },
    })),
    snapshot: deps.snapshot,
  };
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
  const prompt = buildPrompt({ settings, rules: rules.body, snapshot, board });
  const turn = await w.runTurn({ prompt, settings, sessionKey: `${BOARD_WALK_SESSION_KEY_PREFIX}${at}`, title: `Board walk ${at.slice(0, 16).replace("T", " ")}` });
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
    ...applyDecisions({ settings, state, dispatch: w.dispatch, now: w.now }, parsed.decisions),
  ];
  return finish(frame, {
    outcome: "ok",
    summary: `${summarise(entries)}. ${parsed.decisions.summary} Dispatch: ${parsed.decisions.dispatch.reason}`,
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
