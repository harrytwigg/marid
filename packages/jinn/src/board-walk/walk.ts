import cron from "node-cron";
import type { EngineLimitEngineSnapshot, JinnConfig, Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { collectClaudeLimits } from "../shared/engine-limits-claude.js";
import { listSessions, getMessages, getSession } from "../sessions/registry.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { CronConnector } from "../connectors/cron/index.js";
import { getWorkItem, type WorkItem } from "../work-items/store.js";
import { startTodoDispatcher, type StartTodoDispatcherResult } from "../gateway/todo-dispatch.js";
import { sessionsHoldingEngineCapacity, type ApiContext } from "../gateway/api.js";
import { readRules, boardWalkPath, type BoardWalkRules, type BoardWalkSettings } from "./settings.js";
import { buildCapacitySnapshot, claudeFiveHour, type SnapshotDeps } from "./snapshot.js";
import { buildBoardDigest } from "./board.js";
import { buildPrompt } from "./prompt.js";
import { parseDecisions, type StartDecision } from "./decisions.js";
import { applyDecisions, stuckEpisode } from "./apply.js";
import { cachedResolver, ghResolver, type LinkResolver } from "./pr-state.js";
import { BOARD_WALK_SESSION_KEY_PREFIX, BOARD_WALK_STARTED_BY } from "./started-sessions.js";
import { appendTick, readState, readTicks, writeState, type TickEntry, type TickRecord } from "./store.js";

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
  holdingCapacity?: (sessions: readonly Session[]) => Session[];
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
    const sessionId = routed?.sessionId;
    if (!sessionId) return { error: "the walk's session was not started" };
    const settled = getSession(sessionId);
    if (settled?.attemptOutcome === "failed" || settled?.attemptOutcome === "interrupted" || settled?.status === "error") {
      return { sessionId, error: settled.lastError ?? `the walk's turn ${settled.attemptOutcome ?? settled.status}` };
    }
    const reply = [...getMessages(sessionId)].reverse().find((message) => message.role === "assistant" && !message.partial)?.content;
    return reply ? { sessionId, reply } : { sessionId, error: "the walk's turn produced no reply" };
  };
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

export function startBoardWalk(deps: BoardWalkDeps): BoardWalk {
  const now = deps.now ?? Date.now;
  const rulesFile = deps.rulesFile ?? boardWalkPath();
  const resolveLink = deps.resolveLink ?? cachedResolver(ghResolver());
  const runTurn = deps.runTurn ?? routeTurn(deps);
  const sessions = deps.sessions ?? (() => listSessions());
  const holding = deps.holdingCapacity ?? ((list: readonly Session[]) => sessionsHoldingEngineCapacity(list, deps.context));
  const collectClaude = deps.collectClaude ?? collectClaudeLimits;
  const dispatch = deps.dispatch ?? ((item: WorkItem, decision: StartDecision) => startTodoDispatcher(item, deps.context, {
    promptSuffix: dispatcherSuffix(decision),
    transportMeta: { startedBy: BOARD_WALK_STARTED_BY },
  }));

  let inFlight: Promise<TickRecord> | null = null;

  const finish = (record: TickRecord, startedAt: number): TickRecord => {
    const done = { ...record, durationMs: now() - startedAt };
    appendTick(done);
    const line = `Board walk (${done.trigger}): ${done.outcome} — ${done.summary}`;
    if (done.outcome === "failed" || done.outcome === "invalid-rules") logger.warn(line);
    else logger.info(line);
    return done;
  };

  const evaluate = async (trigger: TickRecord["trigger"]): Promise<TickRecord> => {
    const startedAt = now();
    const at = new Date(startedAt).toISOString();
    const rules: BoardWalkRules = readRules(rulesFile);
    if (!rules.exists || rules.problems.length > 0) {
      return finish({ at, trigger, outcome: "invalid-rules", summary: rules.problems.join("; "), entries: [{ kind: "error", reason: rules.problems.join("; ") }] }, startedAt);
    }
    const { settings } = rules;
    if (!settings.enabled) {
      return finish({ at, trigger, outcome: "disabled", summary: "the board walk is switched off (enabled: false)", entries: [] }, startedAt);
    }

    const state = readState();
    const board = await buildBoardDigest({ resolveLink, flagged: flaggedSet(state) });
    if (board.todos.length === 0) {
      return finish({ at, trigger, outcome: "ok", summary: "nothing to do: the board has no open Todos", entries: [{ kind: "nothing", reason: "the board has no open Todos; no model turn was spent" }] }, startedAt);
    }

    const config = deps.getConfig();
    const sessionList = sessions();
    const snapshot = await buildCapacitySnapshot({
      config, timezone: settings.timezone, now: startedAt, sessions: sessionList, holdingCapacity: holding,
      ...(state.priorFiveHour ? { prior: state.priorFiveHour } : {}),
      ...deps.snapshot,
    });
    const prompt = buildPrompt({ settings, rules: rules.body, snapshot, board });
    const turn = await runTurn({ prompt, settings, sessionKey: `${BOARD_WALK_SESSION_KEY_PREFIX}${at}`, title: `Board walk ${at.slice(0, 16).replace("T", " ")}` });

    // The reading after the turn is the next tick's reference: the walk's own
    // spend is then behind it, and is not mistaken for the operator's.
    try {
      const fiveHour = claudeFiveHour(await collectClaude(config), now());
      if (fiveHour) state.priorFiveHour = fiveHour;
      else delete state.priorFiveHour;
    } catch {
      delete state.priorFiveHour;
    }

    const session = turn.sessionId ? { sessionId: turn.sessionId } : {};
    if (turn.error || !turn.reply) {
      writeState(state);
      const reason = turn.error ?? "no reply";
      return finish({ at, trigger, outcome: "failed", summary: `the model turn failed: ${reason}`, ...session, entries: [{ kind: "error", reason }] }, startedAt);
    }
    const parsed = parseDecisions(turn.reply);
    if (!parsed.ok) {
      writeState(state);
      return finish({ at, trigger, outcome: "failed", summary: `the answer could not be used: ${parsed.error}`, ...session, entries: [{ kind: "error", reason: parsed.error }] }, startedAt);
    }

    const entries = [
      ...parsed.problems.map((problem): TickEntry => ({ kind: "refused", reason: problem, outcome: "unreadable decision, ignored" })),
      ...applyDecisions({ settings, state, dispatch, now }, parsed.decisions),
    ];
    writeState(state);
    return finish({ at, trigger, outcome: "ok", summary: `${summarise(entries)}. ${parsed.decisions.summary} Dispatch: ${parsed.decisions.dispatch.reason}`, ...session, entries }, startedAt);
  };

  // One tick at a time: a scheduled fire that lands mid-tick is logged and
  // dropped, never stacked; a manual tick joins the one running.
  const tick = (trigger: TickRecord["trigger"] = "manual"): Promise<TickRecord> => {
    if (inFlight) {
      if (trigger === "schedule") {
        const at = new Date(now()).toISOString();
        appendTick({ at, trigger, outcome: "busy", summary: "the previous tick is still running; this one was skipped", entries: [] });
      }
      return inFlight;
    }
    inFlight = evaluate(trigger)
      .catch((error) => {
        const at = new Date(now()).toISOString();
        const record: TickRecord = { at, trigger, outcome: "failed", summary: `the tick crashed: ${errorText(error)}`, entries: [{ kind: "error", reason: errorText(error) }] };
        appendTick(record);
        logger.warn(`Board walk tick failed: ${errorText(error)}`);
        return record;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  // The schedule follows the file: re-read on a poll, re-armed only when the
  // schedule, zone or switch changed. Disabled means no task at all.
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
      if (rules.problems.length > 0) logger.warn(`Board walk not scheduled: ${rules.problems.join("; ")}`);
      else logger.info("Board walk not scheduled: switched off in board-walk.md");
      return;
    }
    task = cron.schedule(settings.schedule, () => { void tick("schedule"); }, { timezone: settings.timezone, scheduled: false });
    task.start();
    logger.info(`Board walk scheduled: ${settings.schedule} (${settings.timezone})`);
  };
  arm();
  const poll = setInterval(arm, deps.pollMs ?? 60_000);
  poll.unref?.();

  return {
    tick,
    status: () => {
      const rules = readRules(rulesFile);
      const last = readTicks(1)[0];
      return {
        path: rulesFile,
        exists: rules.exists,
        settings: rules.settings,
        problems: rules.problems,
        scheduled: task !== null,
        running: inFlight !== null,
        ...(last ? { lastTick: last } : {}),
      };
    },
    stop: () => {
      clearInterval(poll);
      task?.stop();
      task = null;
    },
  };
}
