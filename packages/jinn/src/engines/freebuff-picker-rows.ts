/**
 * The rows of Freebuff's `/model` picker, read off a rendered screen: a scrolling
 * list of boxed rows, each a label (with its reasoning level after a bullet), a
 * cost multiplier, and a cursor on one of them.
 */

export const PICKER_HINT_LINE = /^↑↓ choose model\b/;

/** A line without the margin or the scrollbar glyphs beside it. */
export const bare = (line: string): string => line.replace(/[\s▀▄█]+$/, "").trim();


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
  const hint = lines.findIndex((l) => PICKER_HINT_LINE.test(bare(l)));
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
