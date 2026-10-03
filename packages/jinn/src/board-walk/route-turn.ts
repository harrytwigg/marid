import type { Employee, JinnConfig } from "../shared/types.js";
import { isEngineExhausted, readEngineHealth } from "../shared/engine-health.js";
import { engineAvailable } from "../shared/models.js";
import { getMessages, getSession } from "../sessions/registry.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { CronConnector } from "../connectors/cron/index.js";
import { OPENCODE_WALK_AGENT } from "../engines/opencode-mcp.js";
import type { BoardWalkSettings } from "./settings.js";
import type { BoardWalkDeps, WalkTurn, WalkTurnResult } from "./walk.js";

/**
 * The walk's turn as a session: who it runs as, with which tools, and how its
 * outcome is read back from the session registry once it settles.
 *
 * The turn runs as the configured employee on the configured engine, with the
 * walk's own tools and nothing else. The walk decides; the gateway acts, so any
 * other tool would be an act nobody checked and the surface is clamped per
 * engine:
 *   - its only MCP server is the jinn server serving the board-walk toolset
 *     (`toolset`), in place of the company belt and every custom server;
 *   - on Claude the built-ins are switched off from the command line
 *     (`--tools ""`), no other MCP configuration is read
 *     (`--strict-mcp-config`), and the Chrome integration the engine always
 *     enables is switched off again (`--no-chrome`) — Claude is the one engine
 *     whose tools can be switched off from the command line;
 *   - on opencode, whose server mode ignores those flags, the turn runs as a
 *     purpose-built agent that denies every tool but the jinn server's (`agent`
 *     in the staged config, opencode-mcp.ts), selected with `--agent`;
 *   - the employee's own flags are dropped for the same reason: they were
 *     written for its own engine.
 * Only the engines that can be clamped this way are allowed (`WALK_ENGINES`);
 * any other is refused with that reason rather than run with an unbounded
 * surface. The rate-limit handler never hands a walk turn to a fallback engine
 * either (rate-limit-handler.ts); a limited walk waits, and the walk's timeout
 * stops it.
 */
export const WALK_ENGINES = ["claude", "opencode"] as const;
export type WalkEngine = (typeof WALK_ENGINES)[number];

/** Claude's own clamps. `--no-chrome` must come after the engine's own
 *  `--chrome` (it does: employee flags are appended), or the browser tools
 *  come back. */
export const CLAUDE_WALK_FLAGS = ["--no-chrome", "--tools", "", "--strict-mcp-config"];

/** opencode's clamp: the confined agent the staged config carries, whose
 *  permissions deny every tool but `jinn_*`. */
export const OPENCODE_WALK_FLAGS = ["--agent", OPENCODE_WALK_AGENT];

export function isWalkEngine(engine: string): engine is WalkEngine {
  return (WALK_ENGINES as readonly string[]).includes(engine);
}

/** The employee's own model when it belongs to the runner's engine; else the
 *  engine's configured model. A model named in the settings is passed to the
 *  session directly (routeTurn), so it needs no place here. */
function walkModel(employee: Employee, settings: BoardWalkSettings, config: JinnConfig): string {
  if (employee.engine === settings.engine) return employee.model;
  const engineConfig = (config.engines as unknown as Record<string, { model?: string } | undefined>)[settings.engine];
  return engineConfig?.model ?? "";
}

/** The employee the walk's turn runs as, clamped to the walk's own tools. */
export function lockedDownEmployee(employee: Employee, settings: BoardWalkSettings, config: JinnConfig): Employee {
  const { remoteHost: _host, remoteUser: _user, remoteCwd: _cwd, ...local } = employee;
  return {
    ...local,
    engine: settings.engine,
    model: walkModel(employee, settings, config),
    mcp: false,
    jinnMcp: false,
    toolset: "board-walk",
    cliFlags: settings.engine === "claude" ? [...CLAUDE_WALK_FLAGS] : [...OPENCODE_WALK_FLAGS],
  };
}

/** Why the walk cannot run as configured, or null when it can. */
function runnerRefusal(settings: BoardWalkSettings, config: JinnConfig): string | null {
  if (!isWalkEngine(settings.engine)) {
    return `the board walk can only run on ${WALK_ENGINES.join(" or ")}, so that its turn has only the walk's tools; "${settings.engine}" cannot be confined to them`;
  }
  if (!engineAvailable(config, settings.engine)) {
    return `the board walk runs on ${settings.engine}, and it is not installed`;
  }
  if (isEngineExhausted(readEngineHealth(), settings.engine)) {
    return `${settings.engine} is recorded as exhausted; this tick is skipped`;
  }
  return null;
}

/** The default turn: a session routed to the rules file's employee, read back
 *  from the registry once the turn settles. */
export function routeTurn(deps: Pick<BoardWalkDeps, "getConfig" | "context">): (turn: WalkTurn) => Promise<WalkTurnResult> {
  return async (turn) => {
    const config = deps.getConfig();
    const { settings } = turn;
    const refusal = runnerRefusal(settings, config);
    if (refusal) return { error: refusal };
    const configured = orgRegistry(config).get(settings.employee);
    if (!configured) return { error: `employee ${settings.employee} named in board-walk.md does not exist` };
    const employee = lockedDownEmployee(configured, settings, config);
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
      {
        employee,
        engine: settings.engine,
        // A pinned engine and named model skip the session layer's healthy-engine
        // choice, so the runner is checked here before routing (runnerRefusal).
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.effortLevel ? { effortLevel: settings.effortLevel } : {}),
        title: turn.title,
      },
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

/** What a settled walk session came to: why it failed, or its closing words if it has any. */
function settledTurn(sessionId: string): WalkTurnResult {
  const failure = turnFailure(sessionId);
  if (failure) return { sessionId, error: failure };
  // The walk's work is in its tool calls; a turn that ends without a closing
  // word after walk_finish has done all of it.
  const reply = [...getMessages(sessionId)].reverse().find((message) => message.role === "assistant" && !message.partial)?.content;
  return reply ? { sessionId, reply } : { sessionId };
}
