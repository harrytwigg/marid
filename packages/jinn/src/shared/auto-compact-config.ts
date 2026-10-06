import type { JinnConfig } from "./types.js";

/**
 * `engines.<claude|opencode>.autoCompact`: the policy that decides
 * when a long session is compacted before its next turn — because its cache
 * has gone cold, or because its context has passed a budget. The
 * decision itself lives in `sessions/auto-compaction.ts`; this is the config
 * half — defaults, resolution and validation — kept free of the session
 * registry so the config loader can use it.
 */

/**
 * The config block. When enabled, a turn on a session whose last-turn context
 * is at least `minContextTokens`, and whose engine has been idle at least
 * `cacheWindowSeconds`, runs the engine's own compaction first. So does a turn
 * on a session whose context has reached `maxContextTokens`, warm or not.
 * Defaults: disabled, 300 s, 100000 tokens, no budget.
 */
export interface AutoCompactConfig {
  enabled?: boolean;
  cacheWindowSeconds?: number;
  minContextTokens?: number;
  maxContextTokens?: number;
}

/** Engines `engines.<name>.autoCompact` may be set on. */
export const AUTO_COMPACT_ENGINES = ["claude", "opencode"] as const;
type AutoCompactEngine = (typeof AUTO_COMPACT_ENGINES)[number];

export interface AutoCompactPolicy {
  enabled: boolean;
  /** How long after the engine's last activity its prompt cache is assumed cold. */
  cacheWindowSeconds: number;
  /** Below this context size a session is not worth compacting. */
  minContextTokens: number;
  /**
   * The context budget: at or above it a session is compacted before its next
   * turn whether its cache is warm or cold. Undefined, the default, leaves a
   * warm session to the engine's own compaction, which waits for the model's
   * context ceiling (opencode's ignores its `compaction.reserved` unless the
   * provider declares `limit.input`, so Jinn cannot lower it by config).
   */
  maxContextTokens?: number;
}

/**
 * Defaults. Claude's prompt cache lives 5 minutes unless a request asks for
 * the 1-hour tier; set 3600 when the account's Claude Code uses that tier.
 * opencode's provider decides its own; 5 minutes is the conservative guess.
 * 100k tokens is where a cold resume starts to cost real money on Opus.
 */
export const AUTO_COMPACT_DEFAULTS: Record<AutoCompactEngine, AutoCompactPolicy> = {
  claude: { enabled: false, cacheWindowSeconds: 300, minContextTokens: 100_000 },
  opencode: { enabled: false, cacheWindowSeconds: 300, minContextTokens: 100_000 },
};

/**
 * Where a session's budget hold lives in its `transportMeta` (see
 * `sessions/auto-compaction.ts`). Named here, free of the registry, so the
 * registry can drop it when it copies a session.
 */
export const AUTO_COMPACT_BUDGET_HOLD_KEY = "autoCompactBudgetHold";

const MIN_CACHE_WINDOW_SECONDS = 1;
const MIN_CONTEXT_TOKENS = 1_000;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAutoCompactEngine(engine: string): engine is AutoCompactEngine {
  return (AUTO_COMPACT_ENGINES as readonly string[]).includes(engine);
}

/** A configured number raised to its floor, or undefined when it is not one. */
function atLeast(value: unknown, minimum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, value) : undefined;
}

/** The policy in force for an engine, defaults filled in. Undefined for an
 *  engine that cannot compact at all. */
export function resolveAutoCompactPolicy(config: Pick<JinnConfig, "engines">, engine: string): AutoCompactPolicy | undefined {
  if (!isAutoCompactEngine(engine)) return undefined;
  const engineConfig = (config.engines as unknown as Record<string, unknown>)[engine];
  const raw = isMapping(engineConfig) && isMapping(engineConfig.autoCompact) ? engineConfig.autoCompact : {};
  const defaults = AUTO_COMPACT_DEFAULTS[engine];
  const budget = atLeast(raw.maxContextTokens, MIN_CONTEXT_TOKENS);
  return {
    enabled: raw.enabled === true,
    cacheWindowSeconds: atLeast(raw.cacheWindowSeconds, MIN_CACHE_WINDOW_SECONDS) ?? defaults.cacheWindowSeconds,
    minContextTokens: atLeast(raw.minContextTokens, MIN_CONTEXT_TOKENS) ?? defaults.minContextTokens,
    ...(budget !== undefined ? { maxContextTokens: budget } : {}),
  };
}

function positiveNumberProblem(path: string, value: unknown, minimum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    return `${path} must be a number of at least ${minimum} (got ${JSON.stringify(value)})`;
  }
  return undefined;
}

/**
 * Shape-check every `engines.<name>.autoCompact`. A typo here would otherwise
 * read as "disabled" or "default" without a word, and the only symptom would be
 * a bill — so a quoted number, a negative window or the block on an engine
 * that cannot compact is caught at the same boundary as any other config error.
 */
export function autoCompactProblems(engines: Record<string, unknown>): string[] {
  return Object.entries(engines).flatMap(([engine, engineConfig]) =>
    isMapping(engineConfig) && engineConfig.autoCompact !== undefined
      ? engineAutoCompactProblems(engine, engineConfig.autoCompact)
      : []);
}

const KNOWN_SETTINGS = new Set(["enabled", "cacheWindowSeconds", "minContextTokens", "maxContextTokens"]);

function engineAutoCompactProblems(engine: string, block: unknown): string[] {
  const path = `engines.${engine}.autoCompact`;
  if (!isAutoCompactEngine(engine)) {
    return [`${path} is not supported: only ${AUTO_COMPACT_ENGINES.join(" and ")} can compact a session`];
  }
  if (!isMapping(block)) return [`${path} must be a mapping`];
  const problems = [
    block.enabled !== undefined && typeof block.enabled !== "boolean"
      ? `${path}.enabled must be a boolean (got ${JSON.stringify(block.enabled)})`
      : undefined,
    positiveNumberProblem(`${path}.cacheWindowSeconds`, block.cacheWindowSeconds, MIN_CACHE_WINDOW_SECONDS),
    positiveNumberProblem(`${path}.minContextTokens`, block.minContextTokens, MIN_CONTEXT_TOKENS),
    positiveNumberProblem(`${path}.maxContextTokens`, block.maxContextTokens, MIN_CONTEXT_TOKENS),
    ...Object.keys(block)
      .filter((key) => !KNOWN_SETTINGS.has(key))
      .map((key) => `${path}.${key} is not a known setting (${[...KNOWN_SETTINGS].join(", ")})`),
  ];
  return problems.filter((problem): problem is string => problem !== undefined);
}
