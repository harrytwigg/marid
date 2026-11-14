import type { HundredfoldConfig } from "../shared/types.js";
import {
  cronCandidates,
  employeeCandidates,
  noteCandidates,
  pageCandidates,
  searchEntities,
  searchSessions,
  skillCandidates,
  textWords,
} from "./entity-results.js";
import { parseSearchQuery } from "./query-grammar.js";
import { searchTodos } from "./todo-results.js";
import { SEARCH_KINDS, type GlobalSearchResponse, type GlobalSearchResult, type ParsedQuery, type SearchKind } from "./types.js";
import { buildSearchVocabulary } from "./vocabulary.js";

/**
 * One query in, ranked cross-entity results out. Kinds are searched
 * independently and concatenated in `SEARCH_KINDS` order — deliberately not
 * interleaved by score, because a stable list is what ⌘K muscle memory needs.
 */

export interface GlobalSearchRequest {
  query: string;
  /** Restrict to one kind. The Todos search box enters with `scope=todos`. */
  scope?: SearchKind;
  literal?: boolean;
  /** Per-kind cap, not a total. */
  limit: number;
  config: HundredfoldConfig;
  /** Notes root; the gateway's test-injectable home when it has one. */
  home?: string;
}

export type GlobalSearchOutcome =
  | { ok: true; value: GlobalSearchResponse }
  | { ok: false; error: string };

interface KindResults {
  results: GlobalSearchResult[];
  total: number;
}

function resultsForKind(kind: SearchKind, parsed: ParsedQuery, request: GlobalSearchRequest): KindResults {
  const { limit, config } = request;
  const words = textWords(parsed.freeText);
  if (kind === "todo") return searchTodos(parsed, limit);
  if (kind === "session") return searchSessions(parsed, limit);
  if (kind === "note") return searchEntities(kind, noteCandidates(request.home), words, limit);
  if (kind === "employee") return searchEntities(kind, employeeCandidates(config), words, limit);
  if (kind === "cron") return searchEntities(kind, cronCandidates(), words, limit);
  if (kind === "skill") return searchEntities(kind, skillCandidates(), words, limit);
  return searchEntities(kind, pageCandidates(config.gateway.notesEnabled === true), words, limit);
}

/** Notes are a gated feature; when it is off the kind does not exist, exactly as
 *  `GET /api/notes` 404s rather than returning an empty list. */
function kindsFor(request: GlobalSearchRequest): SearchKind[] {
  const enabled = SEARCH_KINDS.filter((kind) => kind !== "note" || request.config.gateway.notesEnabled === true);
  return request.scope ? enabled.filter((kind) => kind === request.scope) : enabled;
}

export function runGlobalSearch(request: GlobalSearchRequest): GlobalSearchOutcome {
  const parsed = parseSearchQuery(request.query, buildSearchVocabulary(request.config), { literal: request.literal });
  if (!parsed.ok) return parsed;

  const results: GlobalSearchResult[] = [];
  const counts = Object.fromEntries(SEARCH_KINDS.map((kind) => [kind, 0])) as Record<SearchKind, number>;
  const truncated: SearchKind[] = [];
  for (const kind of kindsFor(request)) {
    const found = resultsForKind(kind, parsed.value, request);
    results.push(...found.results);
    counts[kind] = found.total;
    if (found.total > found.results.length) truncated.push(kind);
  }

  const { facets, freeText, literal } = parsed.value;
  return { ok: true, value: { query: request.query, parsed: { facets, freeText, literal }, results, counts, truncated } };
}
