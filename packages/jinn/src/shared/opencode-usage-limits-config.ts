/**
 * Shape-check `engines.opencode.usageLimits`.
 *
 * The meter reads a bad entry as "not metered" rather than failing, which is
 * the right runtime answer and the wrong way to find out about a typo: a quoted
 * `"60"` or a negative limit would leave opencode silently unmetered. So the
 * same boundary that catches every other config mistake catches these, in the
 * same words. Kept apart from the meter itself, which opens the database.
 */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function monthlyUsdProblems(table: unknown): string[] {
  if (table === undefined) return [];
  if (!isMapping(table)) return ["engines.opencode.usageLimits.monthlyUsd must be a mapping of model id to a monthly USD limit"];
  return Object.entries(table)
    .filter(([, value]) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    .map(([model, value]) => `engines.opencode.usageLimits.monthlyUsd["${model}"] must be a positive number (got ${JSON.stringify(value)})`);
}

export function opencodeUsageLimitsProblems(engines: Record<string, unknown>): string[] {
  const opencode = engines.opencode;
  if (!isMapping(opencode) || opencode.usageLimits === undefined) return [];
  if (!isMapping(opencode.usageLimits)) return ["engines.opencode.usageLimits must be a mapping"];
  return monthlyUsdProblems(opencode.usageLimits.monthlyUsd);
}

/** Shape-check `engines.opencode.subscriptionProviders` and `engines.opencode.reprobeMinutes`: a mistyped list would leave a subscription held like pay-as-you-go, and a quoted `"30"` would silently fall back to an hour. */
export function opencodeSubscriptionProblems(engines: Record<string, unknown>): string[] {
  const opencode = engines.opencode;
  if (!isMapping(opencode)) return [];
  const problems: string[] = [];
  const providers = opencode.subscriptionProviders;
  if (providers !== undefined && (!Array.isArray(providers) || providers.some((name) => typeof name !== "string" || name.trim() === ""))) {
    problems.push("engines.opencode.subscriptionProviders must be a list of provider names");
  }
  const minutes = opencode.reprobeMinutes;
  if (minutes !== undefined && (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0)) {
    problems.push(`engines.opencode.reprobeMinutes must be a positive number of minutes (got ${JSON.stringify(minutes)})`);
  }
  return problems;
}
