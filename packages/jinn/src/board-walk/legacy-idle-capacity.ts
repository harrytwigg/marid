/**
 * The retired `gateway.idleCapacity` block, kept only so an upgrade can turn
 * one into prose. Nothing at runtime reads these numbers any more: the board
 * walk's dispatch rules live in `board-walk.md`, and the shipped Dispatch section
 * there is exactly what `renderDispatchSection(resolveLegacyPolicy(undefined))`
 * produces (a test holds the two together).
 */

export type LegacyTier = "overnight" | "daytime" | "interactive";

interface LegacyWindowPolicy { maxUsedPercent: number; lookaheadMinutes: number }

interface LegacyTierPolicy {
  enabled: boolean;
  fiveHour: LegacyWindowPolicy;
  sevenDay: LegacyWindowPolicy;
  maxDispatchesPerWindow: number;
  maxActiveSessions: number;
}

export interface LegacyIdleCapacityPolicy {
  enabled: boolean;
  intervalMinutes: number;
  timezone: string;
  quietHours: { start: string; end: string };
  operatorActivity: { idleMinutes: number; usageDeltaPercent: number };
  tiers: Record<LegacyTier, LegacyTierPolicy>;
  requireLabel: string | null;
}

const TIERS: readonly LegacyTier[] = ["overnight", "daytime", "interactive"];

/** The defaults the retired loop resolved an absent key to. */
export const LEGACY_DEFAULTS: LegacyIdleCapacityPolicy = {
  enabled: false,
  intervalMinutes: 10,
  timezone: "Europe/London",
  quietHours: { start: "01:00", end: "06:00" },
  operatorActivity: { idleMinutes: 30, usageDeltaPercent: 2 },
  tiers: {
    overnight: { enabled: true, fiveHour: { maxUsedPercent: 85, lookaheadMinutes: 300 }, sevenDay: { maxUsedPercent: 85, lookaheadMinutes: 1440 }, maxDispatchesPerWindow: 3, maxActiveSessions: 1 },
    daytime: { enabled: true, fiveHour: { maxUsedPercent: 50, lookaheadMinutes: 120 }, sevenDay: { maxUsedPercent: 75, lookaheadMinutes: 1440 }, maxDispatchesPerWindow: 2, maxActiveSessions: 1 },
    interactive: { enabled: true, fiveHour: { maxUsedPercent: 20, lookaheadMinutes: 30 }, sevenDay: { maxUsedPercent: 60, lookaheadMinutes: 1440 }, maxDispatchesPerWindow: 1, maxActiveSessions: 1 },
  },
  requireLabel: null,
};

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VALID: Record<string, (raw: unknown) => boolean> = {
  number: (raw) => typeof raw === "number" && Number.isFinite(raw),
  boolean: (raw) => typeof raw === "boolean",
  string: (raw) => typeof raw === "string" && raw.trim() !== "",
};

/** Keep a value only when it has the type the default has; anything else is
 *  dropped, as the old loader would have refused it outright. */
function pick<T>(raw: unknown, fallback: T): T {
  if (!VALID[typeof fallback]?.(raw)) return fallback;
  return (typeof raw === "string" ? raw.trim() : raw) as T;
}

function resolveWindow(base: LegacyWindowPolicy, raw: unknown): LegacyWindowPolicy {
  const r = isMapping(raw) ? raw : {};
  return { maxUsedPercent: pick(r.maxUsedPercent, base.maxUsedPercent), lookaheadMinutes: pick(r.lookaheadMinutes, base.lookaheadMinutes) };
}

function resolveTier(base: LegacyTierPolicy, raw: unknown): LegacyTierPolicy {
  const r = isMapping(raw) ? raw : {};
  return {
    enabled: pick(r.enabled, base.enabled),
    fiveHour: resolveWindow(base.fiveHour, r.fiveHour),
    sevenDay: resolveWindow(base.sevenDay, r.sevenDay),
    maxDispatchesPerWindow: pick(r.maxDispatchesPerWindow, base.maxDispatchesPerWindow),
    maxActiveSessions: pick(r.maxActiveSessions, base.maxActiveSessions),
  };
}

/** A raw `gateway.idleCapacity` mapping, every key resolved. */
export function resolveLegacyPolicy(raw: unknown): LegacyIdleCapacityPolicy {
  const d = LEGACY_DEFAULTS;
  const r = isMapping(raw) ? raw : {};
  const quiet = isMapping(r.quietHours) ? r.quietHours : {};
  const activity = isMapping(r.operatorActivity) ? r.operatorActivity : {};
  const tiers = isMapping(r.tiers) ? r.tiers : {};
  return {
    enabled: pick(r.enabled, d.enabled),
    intervalMinutes: pick(r.intervalMinutes, d.intervalMinutes),
    timezone: pick(r.timezone, d.timezone),
    quietHours: { start: pick(quiet.start, d.quietHours.start), end: pick(quiet.end, d.quietHours.end) },
    operatorActivity: {
      idleMinutes: pick(activity.idleMinutes, d.operatorActivity.idleMinutes),
      usageDeltaPercent: pick(activity.usageDeltaPercent, d.operatorActivity.usageDeltaPercent),
    },
    tiers: Object.fromEntries(TIERS.map((tier) => [tier, resolveTier(d.tiers[tier], tiers[tier])])) as Record<LegacyTier, LegacyTierPolicy>,
    requireLabel: typeof r.requireLabel === "string" && r.requireLabel.trim() ? r.requireLabel.trim() : null,
  };
}

// ── Prose ────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function formatSpan(minutes: number): string {
  return minutes % 60 === 0 ? plural(minutes / 60, "hour", "hours") : plural(minutes, "minute", "minutes");
}

const SITUATIONS: Record<LegacyTier, { label: string; when: string }> = {
  overnight: { label: "Overnight", when: "quiet hours, operator not live" },
  daytime: { label: "Daytime", when: "outside quiet hours, operator not live" },
  interactive: { label: "Operator live", when: "any time" },
};

function tierRow(tier: LegacyTier, rules: LegacyTierPolicy): string {
  const { label, when } = SITUATIONS[tier];
  if (!rules.enabled) return `| ${label} | ${when} | never start | never start | — | 0 |`;
  const reset = `${formatSpan(rules.fiveHour.lookaheadMinutes)} (5-hour window) or ${formatSpan(rules.sevenDay.lookaheadMinutes)} (weekly)`;
  return `| ${label} | ${when} | ${rules.fiveHour.maxUsedPercent}% | ${rules.sevenDay.maxUsedPercent}% | ${reset} | ${rules.maxDispatchesPerWindow} |`;
}

function concurrencyRule(policy: LegacyIdleCapacityPolicy): string {
  const limits = TIERS.map((tier) => policy.tiers[tier].maxActiveSessions);
  const sentence = (n: number): string => n <= 1
    ? "while any session already holds engine capacity (running, queued or waiting)"
    : `while ${n} or more sessions already hold engine capacity (running, queued or waiting)`;
  if (limits.every((n) => n === limits[0])) return `**Concurrency.** Start nothing ${sentence(limits[0])}.`;
  const parts = TIERS.map((tier) => `${SITUATIONS[tier].label.toLowerCase()}: ${sentence(policy.tiers[tier].maxActiveSessions)}`);
  return `**Concurrency.** Start nothing ${parts.join("; ")}.`;
}

/** The `## Dispatch` section of `board-walk.md`, stating `policy` in prose. */
export function renderDispatchSection(policy: LegacyIdleCapacityPolicy): string {
  const { idleMinutes, usageDeltaPercent } = policy.operatorActivity;
  const off = TIERS.filter((tier) => !policy.tiers[tier].enabled).map((tier) => SITUATIONS[tier].label.toLowerCase());
  const lines = [
    "## Dispatch",
    "",
    "Start backlog work when Claude allowance would otherwise lapse unused, without",
    "crowding the operator's own use. Every number here is a default, not a limit in",
    "code: change any of them.",
    "",
    "**Who is around.** The operator is live when the snapshot shows any of these",
    `within the last ${plural(idleMinutes, "minute", "minutes")}: activity on a session they drive, a turn in a Jinn`,
    `interactive Claude session, or the Claude five-hour usage rising by ${plural(usageDeltaPercent, "point", "points")} or`,
    "more since the previous tick while no Jinn session ran. The quiet hours are",
    `${policy.quietHours.start} to ${policy.quietHours.end} local time.`,
    "",
    "**Three situations.** Pick the one that applies; the operator being live",
    "outranks the clock.",
    "",
    "| Situation | When | Start only while the 5-hour window is at or under | and every weekly window at or under | and the window resets within | Starts per 5-hour window |",
    "|---|---|---|---|---|---|",
    ...TIERS.map((tier) => tierRow(tier, policy.tiers[tier])),
    ...(off.length > 0 ? ["", `Never start anything in these situations: ${off.join(", ")}.`] : []),
    "",
    "A start needs a reason to go: the five-hour window resets within its lookahead",
    "with its usage under the ceiling, or the weekly window resets within its",
    "lookahead with every window under its ceiling. Otherwise the allowance is not",
    "about to lapse, so hold.",
    "",
    "**Hold, never guess.** Start nothing when the Claude reading is missing, stale,",
    "errored, or lacks a five-hour or weekly window with a reset still ahead, or when",
    "Claude is recorded as exhausted.",
    "",
    concurrencyRule(policy),
    "",
    "**How many.** At most one start per tick. Count the starts in the current",
    "five-hour window from the snapshot's sessions started by the board walk.",
    "",
    "**Which Todo.** Only Todos in `backlog` that are ready." + (policy.requireLabel ? ` Only Todos labelled \`${policy.requireLabel}\`.` : "") + " Highest priority first,",
    "then the oldest. Skip a Todo whose dispatch override names an engine other than",
    "Claude: it would not use the Claude allowance. Prefer that the Todo goes to an",
    "employee on Claude.",
  ];
  return lines.join("\n");
}

/** The cron expression closest to "every `minutes` minutes". Under an hour a
 *  step that does not divide 60 restarts at each hour, which is close enough. */
export function intervalToCron(minutes: number): string {
  const n = Math.max(1, Math.round(minutes));
  if (n < 60) return `*/${n} * * * *`;
  const hours = Math.max(1, Math.round(n / 60));
  return hours >= 24 ? "0 0 * * *" : hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
}

/** Replace the `## Dispatch` section of a rules file (up to the next `## `
 *  heading) with `section`. A file without one gets it appended. */
export function replaceDispatchSection(text: string, section: string): string {
  const start = text.search(/^## Dispatch[ \t]*$/m);
  if (start === -1) return `${text.trimEnd()}\n\n${section}\n`;
  const rest = text.slice(start + 1);
  const next = rest.search(/^## /m);
  const end = next === -1 ? text.length : start + 1 + next;
  return `${text.slice(0, start)}${section}\n\n${text.slice(end).replace(/^\n+/, "")}`.trimEnd() + "\n";
}

export interface ConvertedRules {
  text: string;
  /** What the conversion changed in the frontmatter, for the upgrade log. */
  notes: string[];
}

/**
 * The shipped rules file, rewritten to say what a custom `gateway.idleCapacity`
 * block said: its numbers in the Dispatch section, its timezone and (when set)
 * its tick interval in the frontmatter, and dispatch switched off when the block
 * left the old loop off — the board walk ships on, but an operator who had the
 * auto-start off had not agreed to automatic starts.
 */
export function convertLegacyBlock(template: string, raw: unknown): ConvertedRules {
  const policy = resolveLegacyPolicy(raw);
  const notes: string[] = [];
  let text = replaceDispatchSection(template, renderDispatchSection(policy));
  text = text.replace(/^timezone:.*$/m, `timezone: ${JSON.stringify(policy.timezone)}`);
  notes.push(`timezone ${policy.timezone}`);
  if (isMapping(raw) && typeof raw.intervalMinutes === "number") {
    const schedule = intervalToCron(raw.intervalMinutes);
    text = text.replace(/^schedule:.*$/m, `schedule: ${JSON.stringify(schedule)}`);
    notes.push(`schedule ${schedule} (was every ${raw.intervalMinutes} min)`);
  }
  if (!policy.enabled) {
    text = text.replace(/^(\s+dispatch:)\s*true\s*$/m, "$1 false");
    notes.push("dispatch off (the auto-start was not enabled)");
  }
  return { text, notes };
}
