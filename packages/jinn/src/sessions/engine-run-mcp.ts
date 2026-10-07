import type { Employee, JinnConfig, ResolvedMcpConfig, Session } from "../shared/types.js";
import { attachSessionIdentity } from "../mcp/identity.js";
import { departmentMcpEnv } from "../gateway/department-scope/session-env.js";
import { confineMcpToDepartment } from "../gateway/department-scope/mcp-servers.js";
import { logger } from "../shared/logger.js";
import { getSession } from "./registry.js";
import { sessionScopeDepartment } from "./session-scope.js";
import { scopedDepartmentOf } from "../work-items/department-scope.js";
import { buildJinnServerSpec, isMcpCapableEngine, resolveMcpServers, writeMcpConfigFile } from "../mcp/resolver.js";

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

  // A department-scoped session gets `jinn` and only the instance servers its
  // department allow-lists. The session's department (its binding, else its own
  // employee's scope) decides, and failing that the scope of the employee this
  // turn runs as: a session record with neither must not lift the confinement.
  const department = sessionScopeDepartment(getSession(opts.sessionId)) ?? scopedDepartmentOf(opts.employee?.name);
  // A purpose-built toolset is the turn's entire MCP surface: no custom server,
  // no company belt, and no attachment gate, which decides the belt alone. The
  // server keeps the name `jinn` so it is bound to the session like the belt.
  const mcpConfig = opts.employee?.toolset
    ? { mcpServers: { jinn: buildJinnServerSpec(opts.employee.toolset) } }
    : confinedForDepartment(resolveMcpServers(opts.config.mcp, opts.employee, opts.engine), department, opts.employee);
  if (Object.keys(mcpConfig.mcpServers).length === 0) return {};

  // A department-scoped session's server offers the scoped tool profile and holds file paths to its roots.
  const resolvedMcp = attachSessionIdentity(mcpConfig, opts.sessionId, departmentMcpEnv(opts.sessionId));
  return {
    resolvedMcp,
    ...(opts.engine === "claude" ? { mcpConfigPath: writeMcpConfigFile(resolvedMcp, opts.sessionId) } : {}),
  };
}

/** Confine to the department, naming any server the employee's own `mcp` list asked for that the department does not allow. */
function confinedForDepartment(resolved: ResolvedMcpConfig, department: string | null, employee: Employee | undefined): ResolvedMcpConfig {
  const confined = confineMcpToDepartment(resolved, department);
  if (department && Array.isArray(employee?.mcp)) {
    for (const name of employee.mcp) {
      if (resolved.mcpServers[name] && !confined.mcpServers[name]) {
        logger.warn(`Employee ${employee.name} requests MCP server "${name}" but department "${department}" does not allow it (add it to the department's mcp list)`);
      }
    }
  }
  return confined;
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
