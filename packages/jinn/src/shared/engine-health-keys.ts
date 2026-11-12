import { healthKeys } from "./fallback-chain-health.js";
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
