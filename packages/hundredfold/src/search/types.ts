/**
 * The wire contract of `GET /api/search/global`: one query in, ranked results
 * across every entity kind out, each carrying why it matched and enough to
 * render the preview pane without a second round-trip.
 *
 * Waves 3, 4 and 5 of the ⌘K search workspace are written against these shapes,
 * so changing one here changes a published contract.
 */

export type SearchKind = 'todo' | 'session' | 'note' | 'employee' | 'cron' | 'skill' | 'page';

/** Presentation order. Results are grouped by kind in this order, never
 *  reordered by score across kinds — a stable list is what makes ⌘K muscle
 *  memory possible. */
export const SEARCH_KINDS: readonly SearchKind[] = ['todo', 'session', 'note', 'employee', 'cron', 'skill', 'page'];

export type FacetKind = 'status' | 'assignee' | 'department' | 'label';

/** The exact characters of the query a facet consumed, so a client can render
 *  the chip and remove it again without re-parsing. */
export interface QuerySpan {
  start: number;
  end: number;
  text: string;
}

export interface QueryFacet {
  kind: FacetKind;
  /** The canonical vocabulary entry, not the characters that were typed. */
  value: string;
  origin: 'token' | 'inferred';
  span: QuerySpan;
}

export interface ParsedQuery {
  facets: QueryFacet[];
  /** What is left once facets and connectives are removed; '' means no text filter. */
  freeText: string;
  /** An exact Todo id in the query. It stays inside `freeText` — the index is
   *  what scores an exact id ahead of every text hit. */
  todoId: string | null;
  literal: boolean;
}

export type SearchMatchField =
  // Todos, mirroring WorkItemMatch so a client renders both the same way.
  | 'id' | 'title' | 'body' | 'comment'
  // The other kinds.
  | 'name' | 'description' | 'prompt' | 'persona' | 'path'
  // Selected by a facet rather than by text.
  | FacetKind;

export interface SearchMatchReason {
  field: SearchMatchField;
  /** Surrounding text with the hits wrapped in `<mark>`. */
  snippet: string;
  /** The matching comment, present only when `field` is `comment`. */
  commentId?: string;
}

export interface SearchPreview {
  title: string;
  subtitle?: string;
  status?: string;
  owner?: string;
  excerpt: string;
  url: string;
}

export interface GlobalSearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  /** The canonical deep link Enter opens. */
  url: string;
  /** Never empty — a row that cannot say why it is here does not belong here. */
  reason: SearchMatchReason[];
  preview: SearchPreview;
}

export interface GlobalSearchResponse {
  query: string;
  /** How the query was understood, so the client can show it back. */
  parsed: { facets: QueryFacet[]; freeText: string; literal: boolean };
  results: GlobalSearchResult[];
  /** Matches found per kind, before the per-kind cap. */
  counts: Record<SearchKind, number>;
  /** Kinds with more matches than the cap returned. */
  truncated: SearchKind[];
}
