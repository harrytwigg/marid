import type { HundredfoldConfig } from "../shared/types.js";

/** Names the operator wrote. A list that is not a list names nobody, which keeps a
 *  mistyped `plugins.enabled` fail-closed instead of enabling everything. */
function namesIn(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Is this plugin enabled?
 *
 * Absence is not enabled. The two lists are the operator's explicit decisions and
 * the only input to this one: a plugin named in neither is disabled, because a
 * directory can arrive in the instance home by being copied and must not start
 * running because nobody has said no yet. `disabled` wins over `enabled` when a
 * plugin somehow appears in both — the fail-closed reading is the safe one.
 */
export function isPluginEnabled(id: string, config: Pick<HundredfoldConfig, "plugins">): boolean {
  const plugins = config.plugins;
  if (!plugins) return false;
  if (namesIn(plugins.disabled).includes(id)) return false;
  return namesIn(plugins.enabled).includes(id);
}
