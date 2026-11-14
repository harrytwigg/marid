import type { ParsedQuery, SearchMatchReason } from "./types.js";

/**
 * Building the "why did this match" half of a result.
 *
 * Todos get their snippets from FTS5, which wraps hits in `<mark>` itself. The
 * other kinds are matched in process, so they render their own snippets — the
 * same way, so a client has one thing to draw.
 */

/** Characters of context kept on each side of a hit. */
const SNIPPET_RADIUS = 60;

export function withoutMarks(snippet: string): string {
  return snippet.replace(/<\/?mark>/g, "");
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fresh on every call: a `/g` regex carries `lastIndex` between uses. Escaping
 *  is what lets a hostile query like `NEAR(a b)` be searched for rather than
 *  compiled. */
function wordPattern(words: readonly string[]): RegExp {
  return new RegExp(words.map(escapeForRegExp).join("|"), "gi");
}

/** A bounded window around the first hit, every hit inside it marked, or null
 *  when no word landed in this text at all. */
export function snippetAround(value: string, words: readonly string[]): string | null {
  const found = wordPattern(words).exec(value);
  if (!found) return null;
  const start = Math.max(0, found.index - SNIPPET_RADIUS);
  const end = Math.min(value.length, found.index + found[0].length + SNIPPET_RADIUS);
  const window = value.slice(start, end).replace(wordPattern(words), "<mark>$&</mark>");
  return `${start > 0 ? "…" : ""}${window}${end < value.length ? "…" : ""}`;
}

/** Why a row selected purely by structured facets is in the list. Never empty —
 *  a result that cannot say why it matched does not belong in the list. */
export function facetReasons(parsed: ParsedQuery, title: string): SearchMatchReason[] {
  const facets = parsed.facets.map((facet): SearchMatchReason => ({ field: facet.kind, snippet: facet.value }));
  return facets.length > 0 ? facets : [{ field: "title", snippet: title }];
}
