import type { Employee } from "../shared/types.js";
import { isEngineExhausted, readEngineHealth } from "../shared/engine-health.js";
import { engineAvailable } from "../shared/models.js";
import { getMessages, getSession } from "../sessions/registry.js";
import { orgRegistry } from "../gateway/org-registry.js";
import { CronConnector } from "../connectors/cron/index.js";
import type { BoardWalkDeps, WalkTurn, WalkTurnResult } from "./walk.js";

/**
 * The walk's turn as a session: who it runs as, with which tools, and how its
 * outcome is read back from the session registry once it settles.
 */

/**
 * The employee the walk's turn runs as: the configured one, on Claude, with
 * the walk's own tools and nothing else. The walk decides; the gateway acts.
 * Any other tool would be an act nobody checked, so:
 *   - its only MCP server is the jinn server serving the board-walk toolset
 *     (`toolset`), in place of the company belt and every custom server;
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
    toolset: "board-walk",
    // `--no-chrome` must come after the engine's own `--chrome` (it does:
    // employee flags are appended), or the browser tools come back.
    cliFlags: ["--no-chrome", "--tools", "", "--strict-mcp-config"],
  };
}

/** The default turn: a session routed to the rules file's employee, read back
 *  from the registry once the turn settles. */
export function routeTurn(deps: Pick<BoardWalkDeps, "getConfig" | "context">): (turn: WalkTurn) => Promise<WalkTurnResult> {
  return async (turn) => {
    const config = deps.getConfig();
    const configured = orgRegistry(config).get(turn.settings.employee);
    if (!configured) return { error: `employee ${turn.settings.employee} named in board-walk.md does not exist` };
    const employee = lockedDownEmployee(configured, config.engines.claude?.model ?? "sonnet");
    // The pinned engine and named model skip the session layer's healthy-engine
    // choice, so check here rather than walk into a spent window and wait.
    if (!engineAvailable(config, WALK_ENGINE)) return { error: "the board walk runs on Claude so that its turn has only the walk's tools, and Claude is not installed" };
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

