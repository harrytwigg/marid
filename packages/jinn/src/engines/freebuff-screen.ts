/**
 * Reads a rendered Freebuff screen (see freebuff-terminal.ts) into the state the
 * engine acts on. Pure: lines in, a plain object out, so every screen the CLI
 * has been seen to draw is a fixture and nothing here touches a PTY.
 *
 * Freebuff has no machine-readable mode, so the strings below are its own
 * wording as of 0.2.30. A screen none of them recognises is `unknown`, never a
 * guess: the engine waits on unknown, and fails it with a dump after a minute.
 */

export type FreebuffScreenState = "signed-out" | "idle" | "busy" | "picker" | "unknown";

/**
 * What Freebuff prints in its chat when it will not start (or has dropped) a
 * session. The wording is taken from the 0.2.30 binary's own strings, not from a
 * recorded screen: these states cannot be reached on demand.
 */
export type FreebuffRefusal =
  /** "Not enough hours: 0.4 available." */
  | { kind: "no-hours"; text: string }
  /** "Session limit reached." The day's free sessions are used up. */
  | { kind: "session-limit"; text: string }
  /** "Too many Freebuff sessions on this network." */
  | { kind: "network-cap"; text: string }
  /** "Your concurrent-session limit … is reached. Take over to …": only a person can take over. */
  | { kind: "concurrent-limit"; text: string }
  /** "Freebuff is unavailable in <country>." */
  | { kind: "unavailable"; text: string }
  /** "This session was released. Choose a model to start a new session." */
  | { kind: "released"; text: string };

export interface FreebuffStatusBar {
  /** The model's name, without its reasoning level. */
  modelLabel: string;
  /** The reasoning level shown after the `•`, when the model has one. */
  effort?: string;
}

export interface FreebuffScreenInfo {
  state: FreebuffScreenState;
  /** Time left in the hour session, in minutes (rounded down). */
  sessionLeftMinutes?: number;
  /** Context tokens in use, and the share of the window they fill. */
  contextTokens?: number;
  contextPct?: number;
  /** The daily hours balance from the panel above the chat. */
  hoursRemaining?: number;
  hoursTotal?: number;
  /** The panel says the next message starts a session (none is running yet). */
  sessionNotStarted: boolean;
  /** The panel says a session is running. */
  sessionActive: boolean;
  /** `modelLabel`/`effort` as the status bar shows them. */
  statusBar?: FreebuffStatusBar;
  /** A `⎘ • 11s • △▽` footer is on screen: some turn finished, not necessarily this one. */
  turnFooter: boolean;
  /** Seconds the busy line says the turn has run. */
  busySeconds?: number;
  /**
   * Every line that is one of Freebuff's refusals to run (or keep) a session. A line
   * counts only when it STARTS with the refusal, so an answer or a user message that
   * quotes one is not one; the engine also counts only the lines that appeared after
   * its message went in.
   */
  refusals: FreebuffRefusal[];
}

const SIGNED_OUT_MARKERS = [
  "Press ENTER to login",
  "Open this URL in your browser to login",
  "Waiting for login",
];

const IDLE_PLACEHOLDER = "Enter a coding task or / for commands";
const BUSY_PLACEHOLDER = "Add to the current task";
const PICKER_HINT = "choose model";

/**
 * What may stand before a refusal on its line: margin, a box border, and the glyph
 * Freebuff draws beside a notice. Not a quotation mark or a `>`: a line that opens a
 * quote is somebody quoting the words, not the CLI saying them.
 */
const LEAD = "^[\\s│┃║|⚠✕!•*\\-–—]*";
const REFUSALS: Array<{ kind: FreebuffRefusal["kind"]; pattern: RegExp }> = [
  { kind: "no-hours", pattern: new RegExp(`${LEAD}(Not enough hours:.*)$`) },
  { kind: "session-limit", pattern: new RegExp(`${LEAD}(Session limit reached\\..*)$`) },
  { kind: "network-cap", pattern: new RegExp(`${LEAD}(Too many Freebuff sessions on this network\\..*)$`) },
  { kind: "concurrent-limit", pattern: new RegExp(`${LEAD}(Your concurrent-session limit.*|Limited access without a subscription allows one session.*)$`) },
  { kind: "unavailable", pattern: new RegExp(`${LEAD}(Freebuff is unavailable in .*)$`) },
  { kind: "released", pattern: new RegExp(`${LEAD}(This session was released\\..*)$`) },
];

const BUSY_LINE = /^\s*working\.\.\..*?(?:(\d+)s\s+)?■\s*Esc\s*$/;
const TURN_FOOTER = /⎘\s*•\s*[0-9hms ]+•/;
const HOURS_REMAINING = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*hours?\s+remaining/i;
// `58m left · 13.5K (1%)`, `1h left · …`, `1h 1m left`, and `4:59 left` for the last five minutes.
const SESSION_LINE = /^\s*((?:\d+h)?\s*(?:\d+m)?\s*(?:\d+s)?|\d+:\d{2})\s*left\b(?:\s*·\s*([\d.]+)\s*([KMkm])?\s*\((\d+)%\))?/;

export function parseTokenCount(value: string, unit: string | undefined): number {
  const n = Number(value);
  const multiplier = unit?.toLowerCase() === "m" ? 1_000_000 : unit?.toLowerCase() === "k" ? 1_000 : 1;
  return Math.round(n * multiplier);
}

function minutesOf(duration: string): number | undefined {
  const clock = /^(\d+):\d{2}$/.exec(duration.trim());
  if (clock) return Number(clock[1]);
  const h = /(\d+)h/.exec(duration)?.[1];
  const m = /(\d+)m/.exec(duration)?.[1];
  const s = /(\d+)s/.exec(duration)?.[1];
  if (h === undefined && m === undefined && s === undefined) return undefined;
  return Number(h ?? 0) * 60 + Number(m ?? 0);
}

/** The status bar: `<model> • <effort> · <cwd> · /model to change · Chat: <title>`. */
export function parseStatusBar(lines: readonly string[]): FreebuffStatusBar | undefined {
  const line = lines.find((l) => l.includes("/model to change"));
  if (!line) return undefined;
  const modelSegment = line.trim().split(" · ")[0];
  const bullet = modelSegment.lastIndexOf(" • ");
  if (bullet < 0) return { modelLabel: modelSegment.trim() };
  const effort = modelSegment.slice(bullet + 3).trim();
  return { modelLabel: modelSegment.slice(0, bullet).trim(), ...(effort ? { effort } : {}) };
}

function readHours(text: string, info: FreebuffScreenInfo): void {
  const hours = HOURS_REMAINING.exec(text);
  if (!hours) return;
  info.hoursRemaining = Number(hours[1]);
  info.hoursTotal = Number(hours[2]);
}

/** The session clock, and the context beside it when the line carries one. */
function readSessionLine(lines: readonly string[], info: FreebuffScreenInfo): void {
  for (const line of lines) {
    const session = SESSION_LINE.exec(line);
    const minutes = session ? minutesOf(session[1]) : undefined;
    if (!session || minutes === undefined) continue;
    info.sessionLeftMinutes = minutes;
    if (session[2] !== undefined) {
      info.contextTokens = parseTokenCount(session[2], session[3]);
      info.contextPct = Number(session[4]);
    }
    return;
  }
}

/** The `[04:50 PM]` stamp above each user message; the message runs from there to the next blank line. */
const USER_STAMP = /^\s*\[\d{1,2}:\d{2}\s?[AP]M\]\s*$/;

/** The lines of the screen that are not the user's own words echoed back. */
function outsideUserMessages(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let inMessage = false;
  for (const line of lines) {
    if (USER_STAMP.test(line)) inMessage = true;
    else if (!line.trim()) inMessage = false;
    else if (!inMessage) kept.push(line);
  }
  return kept;
}

function readRefusals(lines: readonly string[]): FreebuffRefusal[] {
  const found: FreebuffRefusal[] = [];
  for (const line of outsideUserMessages(lines)) {
    for (const { kind, pattern } of REFUSALS) {
      // The line as drawn: the transcript's margin and the scrollbar glyphs are not part of it.
      const match = pattern.exec(line.replace(/[\s▀▄█│]+$/, ""));
      if (match) found.push({ kind, text: match[1].trim() });
    }
  }
  return found;
}

/** How many refusal lines of each kind a screen shows. */
export function countRefusals(refusals: readonly FreebuffRefusal[]): Map<FreebuffRefusal["kind"], number> {
  const counts = new Map<FreebuffRefusal["kind"], number>();
  for (const { kind } of refusals) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return counts;
}

/** The first refusal of a kind that has more lines now than `baseline` had: one that appeared since. */
export function newRefusal(refusals: readonly FreebuffRefusal[], baseline: ReadonlyMap<FreebuffRefusal["kind"], number>): FreebuffRefusal | undefined {
  const now = countRefusals(refusals);
  return refusals.find((r) => (now.get(r.kind) ?? 0) > (baseline.get(r.kind) ?? 0));
}

/**
 * Order matters: a sign-in prompt and the picker each cover or replace the input
 * box, and the picker leaves the idle status bar on screen below it.
 */
function readState(text: string, busy: boolean): FreebuffScreenState {
  if (SIGNED_OUT_MARKERS.some((marker) => text.includes(marker))) return "signed-out";
  if (text.includes(PICKER_HINT)) return "picker";
  if (busy || text.includes(BUSY_PLACEHOLDER)) return "busy";
  if (text.includes(IDLE_PLACEHOLDER)) return "idle";
  return "unknown";
}

export function parseFreebuffScreen(lines: readonly string[]): FreebuffScreenInfo {
  const text = lines.join("\n");
  const info: FreebuffScreenInfo = {
    state: "unknown",
    sessionNotStarted: text.includes("Your first message starts the session"),
    sessionActive: /\bSession active\b/.test(text),
    turnFooter: lines.some((l) => TURN_FOOTER.test(l)),
    refusals: readRefusals(lines),
  };
  readHours(text, info);
  readSessionLine(lines, info);
  const statusBar = parseStatusBar(lines);
  if (statusBar) info.statusBar = statusBar;
  const busy = lines.map((l) => BUSY_LINE.exec(l)).find((m): m is RegExpExecArray => m !== null);
  if (busy?.[1] !== undefined) info.busySeconds = Number(busy[1]);
  info.state = readState(text, busy !== undefined);
  return info;
}

// ── The /model picker ────────────────────────────────────────────────────────

export interface FreebuffPickerRow {
  /** The model's name as the picker prints it, without its reasoning level. */
  label: string;
  /** The reasoning level this row is currently set to, when it has one. */
  effort?: string;
  /** The cursor is on this row. */
  selected: boolean;
  /** The cost multiplier on the row's second line (`3x`), when visible. */
  multiplier?: number;
}

const BOX_TOP = /^\s*┌─+┐[\s▀▄█]*$/;
const BOX_BOTTOM = /^\s*└─+┘[\s▀▄█]*$/;
// The picker scrolls and draws a scrollbar glyph in the margin, so a row's
// right edge can carry one extra character after the border.
const BOX_INNER = /^\s*│\s?(.*?)\s*│[\s▀▄█]*$/;

/** `DeepSeek V4.1 Flash 10/17 • high · Smart & Fast` → label and effort. */
export function parsePickerLabel(firstLine: string): { label: string; effort?: string } {
  const text = firstLine.replace(/^[›>]\s*/, "").trim();
  const bullet = text.indexOf(" • ");
  if (bullet >= 0) {
    const label = text.slice(0, bullet).trim();
    const effort = text.slice(bullet + 3).split(" · ")[0].trim();
    return { label, ...(effort ? { effort } : {}) };
  }
  return { label: text.split(" · ")[0].trim() };
}

/** The boxed rows of the `/model` picker, in screen order. Empty if it is not open. */
export function parsePickerRows(lines: readonly string[]): FreebuffPickerRow[] {
  const hint = lines.findIndex((l) => l.includes(PICKER_HINT));
  if (hint < 0) return [];
  const rows: FreebuffPickerRow[] = [];
  let inner: string[] | undefined;
  for (const line of lines.slice(hint + 1)) {
    if (BOX_TOP.test(line)) {
      inner = [];
    } else if (BOX_BOTTOM.test(line)) {
      if (inner?.length) rows.push(rowFromInner(inner));
      inner = undefined;
    } else if (inner) {
      const match = BOX_INNER.exec(line);
      if (match) inner.push(match[1]);
    }
  }
  return rows;
}

function rowFromInner(inner: readonly string[]): FreebuffPickerRow {
  const first = inner[0];
  const selected = /^[›>]/.test(first.trim());
  const { label, effort } = parsePickerLabel(first);
  // A long first line wraps ("… · Promotional · 1" / "session a day"); the
  // multiplier is the line that starts with `<n>x`.
  const multiplier = inner.slice(1).map((l) => /^(\d+(?:\.\d+)?)x\b/.exec(l.trim())).find((m) => m !== null);
  return { label, ...(effort ? { effort } : {}), selected, ...(multiplier ? { multiplier: Number(multiplier[1]) } : {}) };
}

/** Whether a picker label or status-bar model name satisfies a configured prefix. */
export function modelMatches(label: string, wanted: string): boolean {
  return label.trim().toLowerCase().startsWith(wanted.trim().toLowerCase());
}

export function effortMatches(shown: string | undefined, wanted: string): boolean {
  return shown !== undefined && shown.trim().toLowerCase() === wanted.trim().toLowerCase();
}
