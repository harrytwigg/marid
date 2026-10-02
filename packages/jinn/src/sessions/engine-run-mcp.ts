import type { Employee, JinnConfig, ResolvedMcpConfig, Session } from "../shared/types.js";
import { attachSessionIdentity } from "../mcp/identity.js";
import { isMcpCapableEngine, resolveMcpServers, writeMcpConfigFile } from "../mcp/resolver.js";

export interface EngineRunMcp {
  mcpConfigPath?: string;
  resolvedMcp?: ResolvedMcpConfig;
}

export function resolveEngineRunMcp(opts: {
  config: JinnConfig;
  employee?: Employee;
  engine: string;
  sessionId: string;
}): EngineRunMcp {
  if (!isMcpCapableEngine(opts.engine)) return {};

  const mcpConfig = resolveMcpServers(opts.config.mcp, opts.employee, opts.engine);
  if (Object.keys(mcpConfig.mcpServers).length === 0) return {};

  const resolvedMcp = attachSessionIdentity(mcpConfig, opts.sessionId);
  return {
    resolvedMcp,
    ...(opts.engine === "claude" ? { mcpConfigPath: writeMcpConfigFile(resolvedMcp, opts.sessionId) } : {}),
  };
}

/**
 * The MCP set a turn of `session` would run with, outside a turn.
 *
 * For the opencode terminal view, which may start the session's server before
 * any turn has: that server has to carry exactly the MCP set the next turn
 * will ask for, or the turn replaces it (and the view with it). So this makes
 * the same call `preflightTurn` makes.
 */
export function resolveSessionEngineMcp(opts: {
  config: JinnConfig;
  session: Pick<Session, "id">;
  employee?: Employee;
  engine: string;
}): EngineRunMcp {
  return resolveEngineRunMcp({
    config: opts.config,
    employee: opts.employee,
    engine: opts.engine,
    sessionId: opts.session.id,
  });
}
