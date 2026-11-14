import { createNote, listNotes, readNote } from "../../notes/store.js";
import type { NoteDocument, NoteStoreResult, NoteSummary } from "../../shared/note-types.js";
import { PluginHostError } from "./errors.js";
import { assertVerbAllowed, type PluginHostVerb } from "./permissions.js";

export interface PluginNoteDraft {
  title: string;
  body: string;
  /** A folder under the notes root. Omitted, the note lands at the top level. */
  folder?: string;
}

export interface PluginHostNotes {
  list(query?: string): NoteSummary[];
  read(notePath: string): NoteDocument;
  create(draft: PluginNoteDraft): NoteDocument;
}

/**
 * The store answers `{ ok: false, reason, detail }` where a plugin expects a
 * note. Returning that union would make every caller narrow a shape the plugin
 * contract never described, and the failing branch is the one a plugin is most
 * likely to skip — so it becomes a rejection instead, carrying the store's own
 * reason code and wording.
 */
function valueOrThrow<T>(verb: PluginHostVerb, result: NoteStoreResult<T>): T {
  if (!result.ok) throw new PluginHostError(verb, result.reason, `host.${verb} refused: ${result.detail}`);
  return result.value;
}

export function noteVerbs(pluginId: string): PluginHostNotes {
  return {
    list(query) {
      assertVerbAllowed(pluginId, "notes.list");
      // The store also answers the folder tree, which is a browser's navigation
      // aid rather than something a plugin asked for.
      return listNotes(query === undefined ? {} : { query }).notes;
    },
    read(notePath) {
      assertVerbAllowed(pluginId, "notes.read");
      return valueOrThrow("notes.read", readNote(notePath));
    },
    create(draft) {
      assertVerbAllowed(pluginId, "notes.create");
      return valueOrThrow("notes.create", createNote(draft));
    },
  };
}
