/**
 * The client half of `GET /api/search/global`.
 *
 * These shapes mirror `packages/hundredfold/src/search/types.ts` — the gateway owns the
 * contract and no shared package exports it, so a change there is a change here.
 */
import { get } from "@/lib/api"

export type SearchKind = "todo" | "session" | "note" | "employee" | "cron" | "skill" | "page"

/** Presentation order. Results arrive grouped by kind in exactly this order. */
export const SEARCH_KINDS: readonly SearchKind[] = ["todo", "session", "note", "employee", "cron", "skill", "page"]

export type FacetKind = "status" | "assignee" | "department" | "label"

/** The characters of the query a facet consumed, so a chip can be removed again
 *  without re-parsing. Offsets index the `query` the response echoes back. */
export interface QuerySpanWire {
  start: number
  end: number
  text: string
}

export interface QueryFacetWire {
  kind: FacetKind
  /** The canonical vocabulary entry, not the characters that were typed. */
  value: string
  origin: "token" | "inferred"
  span: QuerySpanWire
}

export type SearchMatchFieldWire =
  | "id" | "title" | "body" | "comment"
  | "name" | "description" | "prompt" | "persona" | "path"
  | FacetKind

export interface SearchMatchReasonWire {
  field: SearchMatchFieldWire
  /** Surrounding text with the hits wrapped in `<mark>` and nothing else
   *  escaped, so it is parsed into nodes rather than handed to innerHTML. */
  snippet: string
  commentId?: string
}

export interface SearchPreviewWire {
  title: string
  subtitle?: string
  status?: string
  owner?: string
  excerpt: string
  url: string
}

export interface GlobalSearchResultWire {
  kind: SearchKind
  id: string
  title: string
  url: string
  /** Never empty server-side, facet-only queries included. */
  reason: SearchMatchReasonWire[]
  preview: SearchPreviewWire
}

export interface GlobalSearchWire {
  query: string
  /** How the query was understood, so the client can show it back. */
  parsed: { facets: QueryFacetWire[]; freeText: string; literal: boolean }
  /** Flat: a group is a contiguous run of one kind, in `SEARCH_KINDS` order. */
  results: GlobalSearchResultWire[]
  counts: Record<SearchKind, number>
  truncated: SearchKind[]
}

export interface GlobalSearchParams {
  q: string
  scope?: SearchKind
  literal?: boolean
  /** Per kind, not total. The gateway defaults to 10 and clamps to 1..50. */
  limit?: number
}

/** A query the grammar rejects (`is:nonsense`) comes back as a 400 carrying the
 *  operator-facing reason, which reaches callers as `ApiError.message`. */
export function searchGlobal(params: GlobalSearchParams, signal?: AbortSignal): Promise<GlobalSearchWire> {
  const query = new URLSearchParams({ q: params.q })
  if (params.scope) query.set("scope", params.scope)
  if (params.literal) query.set("literal", "true")
  if (params.limit) query.set("limit", String(params.limit))
  return get<GlobalSearchWire>(`/api/search/global?${query.toString()}`, signal ? { signal } : undefined)
}
