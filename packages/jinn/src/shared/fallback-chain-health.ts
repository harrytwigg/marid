import { isEngineExhausted, type EngineHealth, type EngineHealthReading } from "./engine-health.js";
import type { FallbackLinkHealth, ResolvedFallbackLink } from "./fallback-chain-wire.js";
import type { UsageSample } from "./claude-usage-history.js";

/**
 * Where a chain link's limit state is kept, and what it reads as.
 *
 * Health is advisory (engine-health.ts): it orders a chain and is shown beside
 * it, and never refuses a turn. The keys follow the account a target runs as, so
 * one account's limit does not mark another's links as spent.
 */

/** The parts of a resolved link a health key is made from. */
export type FallbackLinkIdentity = Pick<ResolvedFallbackLink, "engine" | "model" | "account">;

/** The latest cached reading per account key (`readClaudeUsageHistory`'s newest sample); never probed live. */
export type FallbackLimitReadings = Record<string, UsageSample | undefined>;

export interface FallbackHealthInputs {
  health: EngineHealthReading;
  limits?: FallbackLimitReadings;
  now?: Date;
}

function providerOf(model: string | undefined): string | undefined {
  const slash = model === undefined ? -1 : model.indexOf("/");
  return model !== undefined && slash > 0 ? model.slice(0, slash) : undefined;
}

/**
 * The health-store key of a link's target. A Claude link keeps its account's;
 * an opencode link naming `provider/model` keeps its provider's (`opencode/<provider>`),
 * so one provider's usage limit does not mark another provider's links as spent;
 * anything else keeps its engine's.
 */
export function linkHealthKey(link: FallbackLinkIdentity): string {
  if (link.engine === "claude") return link.account;
  const provider = link.engine === "opencode" ? providerOf(link.model) : undefined;
  return provider === undefined ? link.engine : `opencode/${provider}`;
}

/** The keys a link's state is read under: its own, and the engine-wide one (the engine as a whole is out).
 *  A Claude link has no engine-wide key: `claude` is the default account's, not every account's. */
export function healthKeys(link: FallbackLinkIdentity): string[] {
  const key = linkHealthKey(link);
  return link.engine === "claude" || key === link.engine ? [key] : [key, link.engine];
}

/** Whether health says the link's target is at its limit now: its own key or the engine-wide one. */
export function isLinkExhausted(health: EngineHealthReading, link: FallbackLinkIdentity, now: Date = new Date()): boolean {
  return healthKeys(link).some((key) => isEngineExhausted(health, key, now));
}

interface Usage {
  usedPercent: number;
  window: string;
  resetsAt: number;
}

/** The most-used window of the cached reading that has not reset yet: the one that binds. */
function bindingUsage(sample: UsageSample | undefined, now: Date): Usage | undefined {
  let binding: Usage | undefined;
  for (const window of sample?.windows ?? []) {
    if (window.resetsAt * 1000 <= now.getTime()) continue;
    if (binding === undefined || window.usedPercent > binding.usedPercent) {
      binding = { usedPercent: window.usedPercent, window: window.name, resetsAt: window.resetsAt };
    }
  }
  return binding;
}

function usageFields(usage: Usage | undefined): Pick<FallbackLinkHealth, "usedPercent" | "window"> {
  return usage ? { usedPercent: usage.usedPercent, window: usage.window } : {};
}

function untilFields(record: EngineHealth | undefined): Pick<FallbackLinkHealth, "until"> {
  return record?.until === undefined ? {} : { until: record.until };
}

/** How a link reads: what engine health records for its keys, else what the latest cached limits reading says. */
export function linkHealth(inputs: FallbackHealthInputs, link: FallbackLinkIdentity): FallbackLinkHealth {
  const now = inputs.now ?? new Date();
  const records = healthKeys(link).flatMap((key) => inputs.health[key] ?? []);
  const usage = bindingUsage(inputs.limits?.[link.account], now);
  const exhausted = records.find((record) => record.state === "exhausted");
  if (isLinkExhausted(inputs.health, link, now)) {
    return { state: "exhausted", ...untilFields(exhausted), ...usageFields(usage), ...(exhausted?.window ? { window: exhausted.window } : {}) };
  }
  const degraded = records.find((record) => record.state === "degraded");
  if (degraded) return { state: "degraded", ...untilFields(degraded), ...usageFields(usage) };
  if (usage !== undefined && usage.usedPercent >= 100) {
    return { state: "exhausted", until: new Date(usage.resetsAt * 1000).toISOString(), ...usageFields(usage) };
  }
  return { state: "ok", ...usageFields(usage) };
}
