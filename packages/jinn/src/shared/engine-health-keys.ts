import { healthKeys } from "./fallback-chain-health.js";
import type { EngineHealth } from "./engine-health-store.js";
import type { JinnConfig } from "./types.js";

/**
 * The health keys a reader that asks about an ENGINE, with no chain link in hand, reads: the engine's own,
 * and for opencode also its provider's. opencode's health is kept per provider (`opencode/<provider>`), so
 * a reader that looks only at the plain `opencode` key never sees a provider or account that is out.
 *
 * `model` is the model the work runs on; absent, opencode runs the engine's configured one
 * (`engines.opencode.model`), whose provider is read. A model that names no provider reads the engine's key alone.
 */
export function engineReadKeys(
  engine: string,
  config: Pick<JinnConfig, "engines"> | undefined,
  model?: string | null,
): string[] {
  if (engine !== "opencode") return [engine];
  return healthKeys({ engine, model: model || config?.engines.opencode?.model || undefined, account: engine });
}

function untilMs(record: EngineHealth): number {
  const ms = record.until === undefined ? NaN : Date.parse(record.until);
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** The record of `state` that holds longest: the latest `until`; one with no `until` only when none states one. */
function longest(records: readonly EngineHealth[], state: EngineHealth["state"]): EngineHealth | undefined {
  let best: EngineHealth | undefined;
  for (const record of records) {
    if (record.state !== state) continue;
    if (best === undefined || untilMs(record) > untilMs(best)) best = record;
  }
  return best;
}

/**
 * Of the records an engine reader gathered over {@link engineReadKeys}, the one that binds: an `exhausted`
 * record beats a `degraded` one whatever the key order (a provider's short degraded window must not mask the
 * engine being spent), and among records of one state the latest `until` wins (the engine is back only when
 * the last of them reopens). With no record out, the first one (the provider's, then the engine's), if any.
 */
export function bindingHealthRecord(records: readonly EngineHealth[]): EngineHealth | undefined {
  return longest(records, "exhausted") ?? longest(records, "degraded") ?? records[0];
}
