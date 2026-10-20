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

/**
 * Drive an OPEN picker to the wanted model and level, press Enter, and leave it.
 * Throws {@link FreebuffPickerError} (after pressing Esc) when there is no such
 * row or level, naming what the picker offered.
 */
export async function chooseInPicker(io: PickerIO, choice: PickerChoice): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const seen = new Set<string>();
  let lines = await io.screen();
  const note = (rows: readonly FreebuffPickerRow[]) => rows.forEach((r) => seen.add(r.label));

  try {
    if (choice.model) {
      let direction: "down" | "up" = "down";
      let flips = 0;
      for (let step = 0; ; step++) {
        const rows = parsePickerRows(lines);
        note(rows);
        const at = selectedIndex(rows);
        if (rows.length === 0 || at < 0) {
          throw new FreebuffPickerError("the model picker is not showing a selected row", [...seen]);
        }
        if (modelMatches(rows[at].label, choice.model)) break;
        const target = rows.findIndex((r) => modelMatches(r.label, choice.model!));
        if (target >= 0) direction = target > at ? "down" : "up";
        if (step >= MAX_STEPS) {
          throw new FreebuffPickerError(`no model in the picker starts with "${choice.model}"; it showed ${describeLabels(seen)}`, [...seen]);
        }
        await io.press(direction);
        const next = await io.nextScreen(lines);
        const nextRows = parsePickerRows(next);
        const moved = nextRows.find((r) => r.selected)?.label !== rows[at].label;
        lines = next;
        if (!moved && target < 0) {
          // The cursor stopped: the end of the list in this direction.
          note(nextRows);
          if (++flips > 1) {
            throw new FreebuffPickerError(`no model in the picker starts with "${choice.model}"; it showed ${describeLabels(seen)}`, [...seen]);
          }
          direction = direction === "down" ? "up" : "down";
        }
      }
    }

    const wantedEffort = choice.effortLevel && choice.effortLevel !== "default" ? choice.effortLevel : undefined;
    if (wantedEffort) {
      const offered: string[] = [];
      for (let step = 0; ; step++) {
        const row = parsePickerRows(lines).find((r) => r.selected);
        if (!row) throw new FreebuffPickerError("the model picker lost its selected row", [...seen]);
        if (row.effort === undefined) {
          // No level to choose on this model: nothing to match, and not worth failing the turn.
          warnings.push(`"${row.label}" has no reasoning level; ignoring effortLevel "${wantedEffort}"`);
          break;
        }
        if (effortMatches(row.effort, wantedEffort)) break;
        if (!offered.includes(row.effort)) offered.push(row.effort);
        if (step >= MAX_EFFORT_STEPS || (step > 0 && offered.length === step)) {
          // Tab came back to a level already seen: the cycle is exhausted.
          throw new FreebuffPickerError(`"${row.label}" has no reasoning level "${wantedEffort}"; it offered ${offered.map((e) => `"${e}"`).join(", ")}`, [...seen]);
        }
        await io.press("tab");
        lines = await io.nextScreen(lines);
      }
    }

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
