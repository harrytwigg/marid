/** The Note shapes the store, the API and the web app all agree on. Split out of
 *  ./types.js, which re-exports them, so every existing importer is unaffected. */

export interface NoteSummary {
  /** Public path below HUNDREDFOLD_HOME, for example knowledge/product/brief.md. */
  path: string;
  title: string;
  preview: string;
  /** Knowledge-relative directory; the root folder is an empty string. */
  folder: string;
  updatedAt: string;
  /** SHA-256 of the exact file bytes. */
  revision: string;
}

export interface NoteDocument extends NoteSummary {
  /** Editable content after the first Markdown heading. */
  body: string;
}

export interface NoteFolder {
  path: string;
  name: string;
  count: number;
}

export type NoteStoreResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: "invalid-path" | "forbidden" | "not-found" | "conflict" | "too-large" | "already-exists";
      detail: string;
      currentRevision?: string;
    };
