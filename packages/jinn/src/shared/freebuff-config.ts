import type { FallbackChainEntry } from "./fallback-chain-wire.js";

/**
 * `engines.freebuff`: the Freebuff terminal CLI, driven through its screen.
 *
 * Freebuff has no print or JSON mode, so Marid runs the real TUI in a terminal
 * and reads what it draws. Billing is in hours, not money: the first message of
 * an hour session spends hours at the model's multiplier, and every extra
 * concurrent process opens another session. See docs/engines-freebuff.md.
 */
export interface FreebuffEngineConfig {
  /** The CLI. PATH-resolved when absent. */
  bin?: string;
  /**
   * The model, as a prefix of the label the CLI's `/model` picker prints
   * (`MiMo v2.6 Flash Slow`). Unset leaves the CLI's own choice alone. When it
   * differs from the status bar, Marid opens `/model` and selects it; a prefix
   * that matches no row fails the turn, naming the labels the picker showed.
   */
  model?: string;
  /** The reasoning level shown after the `•` in the picker (`high`). Unset leaves it alone. */
  effortLevel?: string;
  childEffortOverride?: string;
  /**
   * How many Freebuff processes may be alive at once, across the gateway and every
   * remote host (default 1). Each one past the first spends hours on a session of
   * its own. A turn that finds the limit reached waits its turn; it does not fail.
   */
  maxConcurrent?: number;
  fallback?: FallbackChainEntry[];
  fallbackModelMap?: Record<string, string>;
}

export const DEFAULT_FREEBUFF_MAX_CONCURRENT = 1;

/** The configured cap, or the default for a missing or nonsensical value. */
export function freebuffMaxConcurrent(config: FreebuffEngineConfig | undefined): number {
  const n = config?.maxConcurrent;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_FREEBUFF_MAX_CONCURRENT;
}
