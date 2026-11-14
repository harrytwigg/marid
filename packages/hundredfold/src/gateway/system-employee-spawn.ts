import { decideHundredfoldAttachment } from "../mcp/attachment.js";
import type { Employee, Engine, HundredfoldConfig } from "../shared/types.js";

/**
 * Can this built-in employee actually run, and if not, which setting fixes it?
 *
 * The Todo Dispatcher and the Todo Shaper ask exactly this before spending
 * anything, and both have to answer with the knob the operator would turn: a
 * system employee that cannot attach the company tools is a session that will
 * burn a turn and achieve nothing, and one whose engine is missing never starts
 * at all. Sharing the answer keeps the two routes from drifting into two
 * different explanations of the same broken configuration.
 */

export type SystemEmployeePreflight =
  | { ok: true; engine: Engine }
  | { ok: false; status: number; error: string };

export function preflightSystemEmployee(opts: {
  employee: Employee;
  /** How the employee is named the first time, e.g. "Todo Dispatcher". */
  label: string;
  /** How its engine override is named, e.g. "Dispatcher". */
  settingLabel: string;
  engineName: string;
  globalMcp: HundredfoldConfig["mcp"];
  getEngine: (name: string) => Engine | undefined;
}): SystemEmployeePreflight {
  const attachment = decideHundredfoldAttachment({ globalMcp: opts.globalMcp, employee: opts.employee, engine: opts.engineName });
  if (!attachment.attach) {
    return {
      ok: false,
      status: 409,
      error: `${opts.label} cannot run on engine "${opts.engineName}" because it cannot attach the hundredfold toolset: ${attachment.reason}. Change the ${opts.settingLabel} engine override or the mcp.gateway settings, then try again.`,
    };
  }
  const engine = opts.getEngine(opts.engineName);
  if (!engine) {
    return {
      ok: false,
      status: 502,
      error: `engine "${opts.engineName}" not available; change the ${opts.settingLabel} engine override and try again`,
    };
  }
  return { ok: true, engine };
}
