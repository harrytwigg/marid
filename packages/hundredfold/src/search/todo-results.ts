import type { WorkItemMatch } from "../work-items/search.js";
import { queryWorkItems, type ListWorkItemsFilter, type WorkItem, type WorkItemStatus } from "../work-items/store.js";
import { facetReasons, withoutMarks } from "./match-reason.js";
import type { GlobalSearchResult, ParsedQuery, SearchMatchReason } from "./types.js";

/**
 * Todos come from wave 1's FTS5 index, which already ranks an exact Todo id
 * ahead of every text hit and hands back the field each hit landed in. This
 * module's whole job is turning that into the wire shape.
 */

const EXCERPT_CHARS = 200;

/** Each facet kind maps onto exactly one of the store's structured filters. */
export function todoFilterFor(parsed: ParsedQuery): ListWorkItemsFilter {
  const filter: ListWorkItemsFilter = {};
  for (const facet of parsed.facets) {
    // The vocabulary is built from the store's own status list, so a status
    // facet can only ever hold a value the column accepts.
    if (facet.kind === "status") filter.status = facet.value as WorkItemStatus;
    if (facet.kind === "assignee") filter.assignee = facet.value;
    if (facet.kind === "department") filter.department = facet.value;
    if (facet.kind === "label") filter.label = facet.value;
  }
  if (parsed.freeText) filter.text = parsed.freeText;
  return filter;
}

function excerptFor(item: WorkItem, found: readonly WorkItemMatch[]): string {
  // An exact-id hit snippets to the id itself, which tells a reader nothing the
  // title does not; prefer any hit that landed in real prose.
  const prose = found.find((match) => match.field !== "id");
  if (prose) return withoutMarks(prose.snippet);
  return (item.body ?? "").trim().slice(0, EXCERPT_CHARS);
}

/** A facet-only query has no text to snippet, but a row still has to say why it
 *  is here — the facet that selected it is the reason. */
function reasonsFor(item: WorkItem, found: WorkItemMatch[], parsed: ParsedQuery): SearchMatchReason[] {
  return found.length > 0 ? found : facetReasons(parsed, item.title);
}

function toResult(item: WorkItem, found: WorkItemMatch[], parsed: ParsedQuery): GlobalSearchResult {
  const url = `/todos/${item.id}`;
  return {
    kind: "todo",
    id: item.id,
    title: item.title,
    url,
    reason: reasonsFor(item, found, parsed),
    preview: {
      title: item.title,
      subtitle: item.assignee ? `${item.id} · ${item.assignee}` : item.id,
      status: item.status,
      ...(item.assignee ? { owner: item.assignee } : {}),
      excerpt: excerptFor(item, found),
      url,
    },
  };
}

export function searchTodos(parsed: ParsedQuery, limit: number): { results: GlobalSearchResult[]; total: number } {
  const filter = todoFilterFor(parsed);
  // Every filter key is a narrowing one, so an empty filter would return the
  // whole ledger rather than an answer to the question that was asked.
  if (Object.keys(filter).length === 0) return { results: [], total: 0 };
  const page = queryWorkItems({ ...filter, limit });
  const matches = page.matches ?? {};
  return {
    results: page.workItems.map((item) => toResult(item, matches[item.id] ?? [], parsed)),
    total: page.total,
  };
}
