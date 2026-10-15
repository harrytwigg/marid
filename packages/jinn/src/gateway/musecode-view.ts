import type { Employee, JinnConfig, ResolvedMcpConfig, Session } from "../shared/types.js";
import type { MusecodeInteractiveDeps } from "../engines/musecode-interactive.js";
import { resolveSessionEngineMcp } from "../sessions/engine-run-mcp.js";

/**
 * What the Muse Code terminal view needs from the gateway: the launch a turn of
 * the session would get (the employee's `cliFlags`, its MCP set, the configured
 * binary), read live so a config reload or an employee edit reaches the next
 * terminal that opens.
 */
export function musecodeViewDeps(gateway: {
  getConfig: () => JinnConfig;
  getSession: (id: string) => Session | undefined;
  employeeOf: (session: Session) => Employee | undefined;
}): MusecodeInteractiveDeps {
  return {
    bin: () => gateway.getConfig().engines.musecode?.bin,
    resolveLaunch: (sessionId) => {
      const session = gateway.getSession(sessionId);
      if (!session) return undefined;
      const employee = gateway.employeeOf(session);
      const resolvedMcp: ResolvedMcpConfig | undefined = resolveSessionEngineMcp({
        config: gateway.getConfig(),
        session,
        employee,
        engine: "musecode",
      }).resolvedMcp;
      return { cliFlags: employee?.cliFlags, resolvedMcp };
    },
  };
}
