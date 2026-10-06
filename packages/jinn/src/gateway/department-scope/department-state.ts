import { createNote } from "../../notes/store.js";
import type { NoteDocument } from "../../shared/types.js";
import { resolveJinnHome } from "../../shared/paths.js";

/**
 * A department's state file, `knowledge/departments/<slug>/state.md` (FR-028): the small
 * current-truth file its scoped sessions keep through the note tools. It is created on
 * the first note write into the department's folder, in the shape the company's own
 * state file has: a title, then sections of keyed bullets (`- key: value`).
 */

/** The department's own folder, relative to `knowledge/`. */
export function departmentNotesFolder(slug: string): string {
  return `departments/${slug}`;
}

/** The note title whose file name is `state.md`. */
const STATE_TITLE = "State";

function seedBody(slug: string): string {
  return [
    `What every ${slug} session needs in front of it: current facts, standing preferences, how the work is going.`,
    "Keyed lines are `- key: value`. Correct a line in place instead of appending a contradiction.",
    "",
    "## Current",
    "",
  ].join("\n");
}

/** Create the department's state file when it does not exist yet; returns the note when it did. A file that is already there is left alone. */
export function seedDepartmentState(slug: string, home: string = resolveJinnHome()): NoteDocument | undefined {
  const result = createNote({ title: STATE_TITLE, body: seedBody(slug), folder: departmentNotesFolder(slug) }, home);
  return result.ok ? result.value : undefined;
}
