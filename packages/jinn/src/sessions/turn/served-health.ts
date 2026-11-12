import { linkHealthKey } from "../../shared/fallback-chain-health.js";
import { recordEngineServed } from "../../shared/engine-health.js";
import type { EngineResult, Session } from "../../shared/types.js";
import { rateLimitAccount } from "../rate-limit-account.js";
import type { TurnRun } from "./types.js";

/**
 * A turn that ran and was answered is evidence its target can serve: a limit the
 * engine-health record still holds against it, noted before the turn began, has
 * lifted. The key is the one a limit on this turn would have been held under
 * (`handleRateLimit`'s `limitedKey`), read off the live row so a session standing
 * on a substitute clears the substitute's record and not its own.
 *
 * A turn preempted, answered with a dead conversation or limited says nothing,
 * and neither does a clean turn that produced nothing and cost nothing (a native
 * `/command` that never reached the provider).
 */
export function noteTurnServed(
  run: TurnRun,
  live: Session,
  model: string | undefined,
  outcome: { result: EngineResult; silent: boolean },
): void {
  const { result, silent } = outcome;
  if (silent || result.error) return;
  if (!result.result?.trim() && !result.cost) return;
  const { account } = rateLimitAccount(live.engine, run.input.employee, live);
  const served = model ?? live.model ?? run.plan.engineConfig.model;
  recordEngineServed(linkHealthKey({ engine: live.engine, model: served, account }), run.turnStartedAt, served);
}
