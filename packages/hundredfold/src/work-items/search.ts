import type { Database as DatabaseType } from 'better-sqlite3';
import { parseTodoId } from './id.js';

/**
 * Free-text Todo search over the FTS5 indexes owned by `search-index.ts`.
 * The store asks this module for the matching Todo ids in relevance
 * order, composes its own filters around that id set in SQL, and then asks back
 * for the reason each row of the page it is about to return matched.
 *
 * The two halves are separate because they are bounded differently: the id set
 * must be the WHOLE match set or a structured filter could intersect with a
 * truncated head of it and miss rows, while `snippet()` only ever has to run
 * over one page.
 */

export interface WorkItemMatch {
  /** Where the hit landed. `id` is an exact Todo-id lookup, not a text hit. */
  field: 'id' | 'title' | 'body' | 'comment';
  /** The matching comment, present only when `field` is `comment`. */
  commentId?: string;
  /** Surrounding text with the hits wrapped in `<mark>`. */
  snippet: string;
}

/** bm25 scores a hit negatively — the better the match, the more negative. A
 *  comment hit is lifted above zero so every title/body hit outranks every
 *  comment-only hit, while comments keep their order among themselves. */
const COMMENT_SCORE_FLOOR = 1_000;

/** An exact Todo id is an answer rather than a guess, so it precedes all text. */
const EXACT_ID_SCORE = -1_000_000;

// `snippet()` wraps hits in these sentinels rather than in `<mark>` directly: a
// column with no hit still returns its plain leading text, and that has to be
// told apart from a column whose own text contains the tag. They are replaced
// before a snippet leaves this module.
const HIT_OPEN = String.fromCharCode(2);
const HIT_CLOSE = String.fromCharCode(3);

const OWN_FIELD_SCORES_SQL = `
SELECT wi.id AS itemId, bm25(work_items_fts, 4.0, 1.0) AS score
FROM work_items_fts JOIN work_items wi ON wi.rowid = work_items_fts.rowid
WHERE work_items_fts MATCH ?`;

const COMMENT_SCORES_SQL = `
SELECT c.work_item_id AS itemId, bm25(work_item_comments_fts) AS score
FROM work_item_comments_fts JOIN work_item_comments c ON c.rowid = work_item_comments_fts.rowid
WHERE work_item_comments_fts MATCH ?`;

const OWN_FIELD_REASONS_SQL = `
SELECT wi.id AS itemId,
       snippet(work_items_fts, 0, char(2), char(3), '…', 12) AS titleSnippet,
       snippet(work_items_fts, 1, char(2), char(3), '…', 12) AS bodySnippet,
       bm25(work_items_fts, 4.0, 1.0) AS score
FROM work_items_fts JOIN work_items wi ON wi.rowid = work_items_fts.rowid
WHERE work_items_fts MATCH ? AND wi.id IN (SELECT value FROM json_each(?))`;

const COMMENT_REASONS_SQL = `
SELECT c.work_item_id AS itemId, c.id AS commentId,
       snippet(work_item_comments_fts, 0, char(2), char(3), '…', 12) AS snippet,
       bm25(work_item_comments_fts) AS score
FROM work_item_comments_fts JOIN work_item_comments c ON c.rowid = work_item_comments_fts.rowid
WHERE work_item_comments_fts MATCH ? AND c.work_item_id IN (SELECT value FROM json_each(?))`;

/**
 * Turn free text into an FTS5 MATCH expression that can only ever be a
 * conjunction of literal phrases: every whitespace-separated word is reduced to
 * its letter/digit runs and requoted. `"`, `*`, `NEAR(a b)`, `-foo` and the
 * rest therefore arrive as ordinary search terms and can never reach the FTS5
 * parser as syntax. Null when no searchable term survives.
 */
export function toFtsMatchExpression(text: string): string | null {
  const phrases = text
    .split(/\s+/)
    .map((word) => (word.match(/[\p{L}\p{N}]+/gu) ?? []).join(' '))
    .filter((phrase) => phrase.length > 0)
    .map((phrase) => `"${phrase}"`);
  return phrases.length > 0 ? phrases.join(' AND ') : null;
}

function exactTodoId(text: string): string | null {
  try {
    return parseTodoId(text);
  } catch {
    return null; // ordinary text, not an id — the FTS branch handles it
  }
}

function renderSnippet(snippet: string | null): string {
  return (snippet ?? '').split(HIT_OPEN).join('<mark>').split(HIT_CLOSE).join('</mark>');
}

interface ScoreRow { itemId: string; score: number }
interface OwnFieldRow extends ScoreRow { titleSnippet: string | null; bodySnippet: string | null }
interface CommentRow extends ScoreRow { commentId: string; snippet: string | null }

/**
 * Every Todo matching `text`, best match first, with no ceiling. The ids reach
 * SQL as a single JSON parameter rather than one bind variable each, so the
 * whole match set — not a truncated head of it — is what the store's other
 * filters intersect with and what its counts are computed from.
 */
export function searchWorkItemIds(db: DatabaseType, text: string): string[] {
  const best = new Map<string, number>();
  const keep = (itemId: string, score: number): void => {
    const current = best.get(itemId);
    if (current === undefined || score < current) best.set(itemId, score);
  };

  const exactId = exactTodoId(text);
  if (exactId) keep(exactId, EXACT_ID_SCORE);

  const expression = toFtsMatchExpression(text);
  if (expression) {
    for (const row of db.prepare(OWN_FIELD_SCORES_SQL).all(expression) as ScoreRow[]) keep(row.itemId, row.score);
    for (const row of db.prepare(COMMENT_SCORES_SQL).all(expression) as ScoreRow[]) {
      keep(row.itemId, COMMENT_SCORE_FLOOR + row.score);
    }
  }
  return [...best.keys()].sort((a, b) => best.get(a)! - best.get(b)! || a.localeCompare(b));
}

type ScoredMatch = WorkItemMatch & { score: number };

function recordOwnFieldReasons(rows: OwnFieldRow[], into: Map<string, ScoredMatch[]>): void {
  for (const row of rows) {
    if (row.titleSnippet?.includes(HIT_OPEN)) {
      into.get(row.itemId)?.push({ field: 'title', snippet: renderSnippet(row.titleSnippet), score: row.score });
    }
    if (row.bodySnippet?.includes(HIT_OPEN)) {
      into.get(row.itemId)?.push({ field: 'body', snippet: renderSnippet(row.bodySnippet), score: row.score });
    }
  }
}

/**
 * Why each of `ids` matched `text`, best reason first, keyed by Todo id. Every
 * requested id gets an entry so a caller never has to distinguish "no reason"
 * from "not asked about". Bounded by the caller to the page it is returning,
 * which is what keeps `snippet()` off the whole match set.
 */
export function workItemMatchReasons(
  db: DatabaseType,
  text: string,
  ids: readonly string[],
): Record<string, WorkItemMatch[]> {
  const reasons = new Map<string, ScoredMatch[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return {};

  const exactId = exactTodoId(text);
  if (exactId) reasons.get(exactId)?.push({ field: 'id', snippet: exactId, score: EXACT_ID_SCORE });

  const expression = toFtsMatchExpression(text);
  if (expression) {
    const scope = JSON.stringify(ids);
    recordOwnFieldReasons(db.prepare(OWN_FIELD_REASONS_SQL).all(expression, scope) as OwnFieldRow[], reasons);
    for (const row of db.prepare(COMMENT_REASONS_SQL).all(expression, scope) as CommentRow[]) {
      reasons.get(row.itemId)?.push({
        field: 'comment',
        commentId: row.commentId,
        snippet: renderSnippet(row.snippet),
        score: COMMENT_SCORE_FLOOR + row.score,
      });
    }
  }

  const matches: Record<string, WorkItemMatch[]> = {};
  for (const [id, found] of reasons) {
    found.sort((a, b) => a.score - b.score);
    matches[id] = found.map(({ score: _score, ...match }) => match);
  }
  return matches;
}
