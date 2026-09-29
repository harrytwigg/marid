import type { IdleCapacityTier, IdleCapacityVerdict, IdleCapacityWindowReading } from "./idle-capacity.js";

/**
 * The record of one idle-capacity start, in both directions.
 *
 * The loop leaves one system comment per Todo it starts (FR-012), and
 * that comment is the only record of the start: the audit trail keeps a
 * `comment_added` row with the comment's id and nothing else. The Auto-Dispatch
 * page's history reads those comments back, so the sentence the loop writes and
 * the grammar the page parses have to be one thing — a reword on either side
 * that the other does not know about empties the history silently. Both live
 * here, and a round-trip test built from a real verdict holds them together.
 *
 * The verdict's own reason is quoted verbatim, not rebuilt: its window grammar
 * (`describe`, `formatMinutes`) belongs to shared/idle-capacity.ts, and this
 * module inverts it rather than copying it.
 */

/** The author every start comment carries — the key the history is read by. */
export const IDLE_CAPACITY_ACTOR = "idle-capacity";

export interface IdleCapacityStartRecord {
  verdict: Extract<IdleCapacityVerdict, { act: true }>;
  sessionId: string;
  /** Starts charged to the five-hour window after this one, and the tier's cap. */
  charged: number;
  cap: number;
}

/** A window as the comment printed it. `minutesToReset` is exact for the
 *  five-hour window (`formatMinutes` only drops minutes at a day or more) and to
 *  the hour for a weekly one. */
export type StartWindowReading = Pick<IdleCapacityWindowReading, "name" | "usedPercent" | "minutesToReset">;

export interface ParsedStartNote {
  /** True when the body did not match the whole grammar and only some fields
   *  could be recovered — a comment edited by hand, or written by an older
   *  build. Nothing below is trusted as complete when this is set. */
  partial: boolean;
  tier?: IdleCapacityTier;
  trigger?: "5h" | "7d";
  fiveHour?: StartWindowReading;
  weekly: StartWindowReading[];
  sessionId?: string;
  charged?: number;
  cap?: number;
}

export function formatStartNote({ verdict, sessionId, charged, cap }: IdleCapacityStartRecord): string {
  return [
    `Idle-capacity auto-start: ${verdict.reason}.`,
    `Started the Todo Dispatcher (session ${sessionId}) to use capacity that would otherwise lapse; ${charged} of ${cap} for this five-hour window.`,
  ].join(" ");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const TIERS = "overnight|daytime|interactive";
const NOTE = new RegExp(
  `^Idle-capacity auto-start: (?<tier>${TIERS}) tier, (?<trigger>five-hour|weekly) window about to lapse: (?<summary>.+)\\. ` +
  `Started the Todo Dispatcher \\(session (?<session>[^)]+)\\) to use capacity that would otherwise lapse; (?<charged>\\d+) of (?<cap>\\d+) for this five-hour window\\.$`,
);
/** One window as `describe()` prints it. The verdict only ever names the
 *  five-hour window and the weekly buckets (`7d`, `7d <model>` — the name may
 *  carry spaces or parentheses), so the name grammar is that, lazily, with the
 *  percentage anchoring where it ends. */
const WINDOW_NAME = "5h|7d(?: \\S+)*?";
const MINUTES = "-?\\d+ min|\\d+ h(?: \\d+ min)?|\\d+ d(?: \\d+ h)?";
const WINDOW = new RegExp(`^(?<name>${WINDOW_NAME}) (?<used>-?\\d+(?:\\.\\d+)?)% used, resets in (?<minutes>${MINUTES})$`);
const WINDOW_ANYWHERE = new RegExp(`\\b(?<name>${WINDOW_NAME}) (?<used>-?\\d+(?:\\.\\d+)?)% used, resets in (?<minutes>${MINUTES})`, "g");

/** Inverts `formatMinutes`: `-3 min`, `40 min`, `2 h`, `2 h 5 min`, `1 d`, `2 d 3 h`. */
export function parseMinutes(text: string): number | undefined {
  const min = /^(-?\d+) min$/.exec(text);
  if (min) return Number(min[1]);
  const hours = /^(\d+) h(?: (\d+) min)?$/.exec(text);
  if (hours) return Number(hours[1]) * 60 + Number(hours[2] ?? 0);
  const days = /^(\d+) d(?: (\d+) h)?$/.exec(text);
  if (days) return Number(days[1]) * 24 * 60 + Number(days[2] ?? 0) * 60;
  return undefined;
}

function windowFrom(groups: Record<string, string | undefined> | undefined): StartWindowReading | undefined {
  const minutes = groups?.minutes === undefined ? undefined : parseMinutes(groups.minutes);
  if (!groups?.name || groups.used === undefined || minutes === undefined) return undefined;
  return { name: groups.name, usedPercent: Number(groups.used), minutesToReset: minutes };
}

function splitWindows(windows: StartWindowReading[]): Pick<ParsedStartNote, "fiveHour" | "weekly"> {
  return {
    fiveHour: windows.find((window) => window.name === "5h"),
    weekly: windows.filter((window) => window.name === "7d" || window.name.startsWith("7d ")),
  };
}

/** What can be pulled out of a body that does not match the whole grammar:
 *  each field is looked for on its own, and the result says it is partial. */
function recover(body: string): ParsedStartNote {
  const tier = new RegExp(`\\b(${TIERS}) tier\\b`).exec(body)?.[1] as IdleCapacityTier | undefined;
  const trigger = /\b(five-hour|weekly) window about to lapse\b/.exec(body)?.[1];
  const session = /\(session ([^)]+)\)/.exec(body)?.[1];
  const count = /(\d+) of (\d+) for this five-hour window/.exec(body);
  const windows = [...body.matchAll(WINDOW_ANYWHERE)].map((match) => windowFrom(match.groups))
    .filter((window): window is StartWindowReading => window !== undefined);
  return {
    partial: true,
    ...(tier ? { tier } : {}),
    ...(trigger ? { trigger: trigger === "five-hour" ? "5h" as const : "7d" as const } : {}),
    ...(session ? { sessionId: session } : {}),
    ...(count ? { charged: Number(count[1]), cap: Number(count[2]) } : {}),
    ...splitWindows(windows),
  };
}

/** The start a comment records. A body that matches the whole grammar comes
 *  back complete; anything else comes back `partial` with whatever it held. */
export function parseStartNote(body: string): ParsedStartNote {
  const match = NOTE.exec(body);
  if (!match?.groups) return recover(body);
  const { tier, trigger, summary, session, charged, cap } = match.groups;
  const windows = summary.split("; ").map((part) => windowFrom(WINDOW.exec(part)?.groups));
  if (windows.some((window) => window === undefined)) return recover(body);
  const { fiveHour, weekly } = splitWindows(windows as StartWindowReading[]);
  if (!fiveHour) return recover(body);
  return {
    partial: false,
    tier: tier as IdleCapacityTier,
    trigger: trigger === "five-hour" ? "5h" : "7d",
    fiveHour,
    weekly,
    sessionId: session,
    charged: Number(charged),
    cap: Number(cap),
  };
}
