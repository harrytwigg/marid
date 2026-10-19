import type { Employee, JinnConfig, ResolvedMcpConfig, Session } from "../shared/types.js";
import { MusecodeEngine, type MusecodeEngineOptions } from "../engines/musecode.js";
import { MusecodeInteractiveEngine, type MusecodeInteractiveDeps } from "../engines/musecode-interactive.js";
import type { PtyLifecycleManager, PtyLifecycleOpts } from "../engines/pty-lifecycle.js";
import { exactEffortLevelsForModel, getModelRegistry } from "../shared/models.js";
import { resolveSessionEngineMcp } from "../sessions/engine-run-mcp.js";
import { getSession } from "../sessions/registry.js";
import { orgRegistry } from "./org-registry.js";

/**
 * What the Muse Code terminal view needs from the gateway: the launch a turn of
 * the session would get (the employee's `cliFlags`, its MCP set, the configured
 * binary), read live so a config reload or an employee edit reaches the next
 * terminal that opens.
 */
function viewDeps(getConfig: () => JinnConfig): MusecodeInteractiveDeps {
  const employeeOf = (session: Session): Employee | undefined => (session.employee ? orgRegistry(getConfig()).get(session.employee) : undefined);
  return {
    bin: () => getConfig().engines.musecode?.bin,
    resolveLaunch: (sessionId) => {
      const session = getSession(sessionId);
      if (!session) return undefined;
      const employee = employeeOf(session);
      const resolvedMcp: ResolvedMcpConfig | undefined = resolveSessionEngineMcp({ config: getConfig(), session, employee, engine: "musecode" }).resolvedMcp;
      return { cliFlags: employee?.cliFlags, resolvedMcp };
    },
  };
}

/**
 * The effort levels a turn may send, from the registry as configured now. An
 * unset model means Muse runs its own default, so that is the model judged.
 */
function turnEffortLevels(getConfig: () => JinnConfig): () => (model: string | undefined) => readonly string[] {
  return () => (model) => {
    const config = getConfig();
    return exactEffortLevelsForModel(config, "musecode", model ?? getModelRegistry(config).musecode?.defaultModel);
  };
}

/**
 * Muse Code's two engines: the headless one that runs turns, and the view-only
 * one behind the dashboard terminal. They are made together because a turn has
 * to let go of a terminal that holds its session (Muse allows one owner), which
 * only the view engine can do.
 */
export function createMusecodeEnginePair(gateway: {
  getConfig: () => JinnConfig;
  /** Registers a PTY lifecycle with the gateway's idle cap and pid tracking. */
  createLifecycle: (opts: Pick<PtyLifecycleOpts, "onAdopt" | "onCleanup">) => PtyLifecycleManager;
  refreshPids: () => void;
  engineOptions: MusecodeEngineOptions;
}): { work: MusecodeEngine; pty: MusecodeInteractiveEngine } {
  const lifecycle = gateway.createLifecycle({ onAdopt: gateway.refreshPids, onCleanup: gateway.refreshPids });
  const pty: MusecodeInteractiveEngine = new MusecodeInteractiveEngine(lifecycle, { ...viewDeps(gateway.getConfig), turnRunning: (id) => work.hasLiveRun(id) });
  const work: MusecodeEngine = new MusecodeEngine({ ...gateway.engineOptions, effortLevels: turnEffortLevels(gateway.getConfig), releaseView: (id) => pty.releaseUnviewed(id) });
  return { work, pty };
}
