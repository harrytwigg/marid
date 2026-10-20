import {
  effortMatches,
  modelMatches,
  parseFreebuffScreen,
  parsePickerRows,
  type FreebuffPickerRow,
} from "./freebuff-screen.js";

/**
 * Freebuff takes its model and reasoning level from one place only: the
 * `/model` picker, a scrolling list of boxed rows. ↑↓ moves the cursor, Tab
 * cycles the reasoning level of the row under it, Enter selects, Esc cancels.
 * Nothing in its settings file says which is chosen.
 *
 * The driver is written against {@link PickerIO}, not a PTY, so it runs against
 * a simulated picker in a unit test. It moves ONE key at a time and reads the
 * screen after each: the TUI drops keys that arrive while it is redrawing, so a
 * counted burst of ↓ lands on the wrong row.
 */

export type PickerKey = "up" | "down" | "tab" | "enter" | "escape";

export interface PickerIO {
  /** The rendered screen right now, after pending output has been applied. */
  screen(): Promise<string[]>;
  press(key: PickerKey): Promise<void>;
  /**
   * The screen once it differs from `previous`, or the same screen if nothing
   * changed within the driver's patience (a key at the end of the list moves
   * nothing, and that is information).
   */
  nextScreen(previous: string[]): Promise<string[]>;
}

export interface PickerChoice {
  /** A prefix of the label the picker prints, e.g. `MiMo v2.6 Flash Slow`. */
  model?: string;
  /** The reasoning level shown after `•`. */
  effortLevel?: string;
}

export class FreebuffPickerError extends Error {
  constructor(message: string, readonly labels: readonly string[]) {
    super(message);
    this.name = "FreebuffPickerError";
  }
}

const MAX_STEPS = 80;
const MAX_EFFORT_STEPS = 8;

function selectedIndex(rows: readonly FreebuffPickerRow[]): number {
  return rows.findIndex((r) => r.selected);
}

function describeLabels(seen: ReadonlySet<string>): string {
  return seen.size ? [...seen].map((l) => `"${l}"`).join(", ") : "(none were shown)";
}

/**
 * Whether the status bar already shows the wanted model and level, so `/model`
 * need not be opened at all. A level a model does not have is not a mismatch.
 */
export function choiceSatisfied(choice: PickerChoice, bar: { modelLabel: string; effort?: string } | undefined): boolean {
  if (!bar) return false;
  if (choice.model && !modelMatches(bar.modelLabel, choice.model)) return false;
  if (choice.effortLevel && bar.effort !== undefined && !effortMatches(bar.effort, choice.effortLevel)) return false;
  return true;
}

/** What one walk through the picker has seen and what it has to say. */
interface Walk {
  io: PickerIO;
  lines: string[];
  seen: Set<string>;
}

function noModelError(model: string, seen: ReadonlySet<string>): FreebuffPickerError {
  return new FreebuffPickerError(`no model in the picker starts with "${model}"; it showed ${describeLabels(seen)}`, [...seen]);
}

function noteRows(walk: Walk, rows: readonly FreebuffPickerRow[]): void {
  for (const row of rows) walk.seen.add(row.label);
}

/** Press one key and read the screen it leaves. */
async function step(walk: Walk, key: PickerKey): Promise<FreebuffPickerRow[]> {
  await walk.io.press(key);
  walk.lines = await walk.io.nextScreen(walk.lines);
  const rows = parsePickerRows(walk.lines);
  noteRows(walk, rows);
  return rows;
}

/** Which way to press: toward the wanted row when it is in view, else the way already scanning. */
function heading(rows: readonly FreebuffPickerRow[], at: number, model: string, scanning: PickerKey): { key: PickerKey; inView: boolean } {
  const target = rows.findIndex((r) => modelMatches(r.label, model));
  if (target < 0) return { key: scanning, inView: false };
  return { key: target > at ? "down" : "up", inView: true };
}

/**
 * Move the cursor onto the row whose label starts with `model`, one key at a
 * time. With the row in view, head for it; with it out of view, scroll down
 * until the cursor stops, then up until it stops, and give up.
 */
async function moveToModel(walk: Walk, model: string): Promise<void> {
  let scanning: PickerKey = "down";
  let stops = 0;
  noteRows(walk, parsePickerRows(walk.lines));
  for (let taken = 0; taken <= MAX_STEPS; taken++) {
    const rows = parsePickerRows(walk.lines);
    const at = selectedIndex(rows);
    if (at < 0) throw new FreebuffPickerError("the model picker is not showing a selected row", [...walk.seen]);
    if (modelMatches(rows[at].label, model)) return;
    const { key, inView } = heading(rows, at, model, scanning);
    const after = await step(walk, key);
    if (inView || after.find((r) => r.selected)?.label !== rows[at].label) continue;
    // The cursor stopped: the end of the list in this direction.
    if (++stops > 1) break;
    scanning = scanning === "down" ? "up" : "down";
  }
  throw noModelError(model, walk.seen);
}

/** Tab the selected row through its reasoning levels until it shows `wanted`. */
async function moveToEffort(walk: Walk, wanted: string, warnings: string[]): Promise<void> {
  const offered: string[] = [];
  for (let taken = 0; ; taken++) {
    const row = parsePickerRows(walk.lines).find((r) => r.selected);
    if (!row) throw new FreebuffPickerError("the model picker lost its selected row", [...walk.seen]);
    if (row.effort === undefined) {
      // No level to choose on this model: nothing to match, and not worth failing the turn.
      warnings.push(`"${row.label}" has no reasoning level; ignoring effortLevel "${wanted}"`);
      return;
    }
    if (effortMatches(row.effort, wanted)) return;
    if (!offered.includes(row.effort)) offered.push(row.effort);
    // Tab came back to a level already seen, or the cycle is longer than any real one: it is exhausted.
    if (taken >= MAX_EFFORT_STEPS || (taken > 0 && offered.length === taken)) {
      throw new FreebuffPickerError(`"${row.label}" has no reasoning level "${wanted}"; it offered ${offered.map((e) => `"${e}"`).join(", ")}`, [...walk.seen]);
    }
    await step(walk, "tab");
  }
}

/**
 * Drive an OPEN picker to the wanted model and level, press Enter, and leave it.
 * Throws {@link FreebuffPickerError} (after pressing Esc) when there is no such
 * row or level, naming what the picker offered.
 */
export async function chooseInPicker(io: PickerIO, choice: PickerChoice): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const walk: Walk = { io, lines: await io.screen(), seen: new Set() };
  const wantedEffort = choice.effortLevel && choice.effortLevel !== "default" ? choice.effortLevel : undefined;
  try {
    if (choice.model) await moveToModel(walk, choice.model);
    if (wantedEffort) await moveToEffort(walk, wantedEffort, warnings);
    await io.press("enter");
    return { warnings };
  } catch (err) {
    // Leave the picker either way; a turn must never be typed into it.
    await io.press("escape").catch(() => undefined);
    throw err;
  }
}

/** Whether the screen is still the picker (used to wait for Enter to land). */
export function pickerOpen(lines: readonly string[]): boolean {
  return parseFreebuffScreen(lines).state === "picker";
}
