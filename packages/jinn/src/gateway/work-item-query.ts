import { normalizeLabelName } from "../work-items/labels.js";
import { parseTodoId } from "../work-items/id.js";
import { stripControlChars } from "../shared/sanitize.js";
import type { SearchWorkItemsFilter, WorkItemSource, WorkItemStatus } from "../work-items/store.js";

/**
 * Reading the Todo list/search surface off a URL: every query parameter the
 * `/api/work-items` routes accept, validated into a `SearchWorkItemsFilter`
 * before any of it reaches SQL.
 *
 * Split out of `api.ts` so the routes read as routes. The rule throughout is
 * that an unusable parameter is an explicit error, never a silently ignored
 * one — a filter the caller believes is applied but is not returns the wrong
 * Todos and looks like data loss.
 */

const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = ['backlog', 'executing', 'in_review', 'done', 'blocked', 'cancelled'];
const WORK_ITEM_SOURCES: readonly WorkItemSource[] = ['human', 'delegation', 'cron', 'workflow', 'session', 'connector', 'goal'];

export interface WorkItemQueryParams {
  filter: SearchWorkItemsFilter;
  limit: number;
  offset: number;
}

/** Route-side cap for search query/text params (GRS-020a-fix finding 3). The
 *  MCP tools cap earlier with a friendlier error; this is the substrate
 *  backstop so a hostile curl gets a clean 400, never HTTP-parser noise. */
export const SEARCH_QUERY_ROUTE_CHAR_CAP = 1_024;
/** Read a query param with NUL/control bytes stripped (GRS-020a-fix finding 2)
 *  and whitespace trimmed; empty-after-cleaning collapses to null. */
export function readCleanSearchParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const cleaned = stripControlChars(raw).trim();
  return cleaned || null;
}

function readWorkItemStatusParam(url: URL): WorkItemStatus | undefined | null {
  const status = readCleanSearchParam(url, 'status');
  if (!status) return undefined;
  if (!(WORK_ITEM_STATUSES as readonly string[]).includes(status)) return null;
  return status as WorkItemStatus;
}

function readWorkItemSourceParam(url: URL): WorkItemSource | undefined | null {
  const source = readCleanSearchParam(url, 'source');
  if (!source) return undefined;
  if (!(WORK_ITEM_SOURCES as readonly string[]).includes(source)) return null;
  return source as WorkItemSource;
}

const WORK_ITEM_PAGE_DEFAULT_LIMIT = 20;
const WORK_ITEM_PAGE_MAX_LIMIT = 100;
export const ISO_DATE_OR_INSTANT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** `startAt` in a create or edit body: absent, null (none, or clear on edit),
 *  or an ISO date or timezone-qualified instant, normalized to an ISO instant. */
export function readStartAtField(body: Record<string, unknown>, opts: { blankIsNone?: boolean } = {}): { ok: true; value?: string | null } | { ok: false; error: string } {
  if (!Object.prototype.hasOwnProperty.call(body, 'startAt') || body.startAt === null) return { ok: true, value: body.startAt as null | undefined };
  if (opts.blankIsNone && typeof body.startAt === 'string' && !body.startAt.trim()) return { ok: true, value: null };
  const raw = typeof body.startAt === 'string' ? body.startAt.trim() : '';
  if (!ISO_DATE_OR_INSTANT.test(raw) || Number.isNaN(Date.parse(raw))) return { ok: false, error: 'startAt must be an ISO 8601 timestamp or null' };
  return { ok: true, value: new Date(raw).toISOString() };
}

function readWorkItemIntegerParam(
  url: URL,
  name: 'limit' | 'offset',
  fallback: number,
): { ok: true; value: number } | { ok: false; error: string } {
  const raw = url.searchParams.get(name);
  if (raw === null) return { ok: true, value: fallback };
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: `${name} must be a non-negative integer` };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false, error: `${name} must be a safe integer` };
  if (name === 'limit') {
    if (value < 1) return { ok: false, error: 'limit must be at least 1' };
    return { ok: true, value: Math.min(value, WORK_ITEM_PAGE_MAX_LIMIT) };
  }
  return { ok: true, value };
}

function readWorkItemDateParam(
  url: URL,
  name: 'since' | 'until',
): { ok: true; value?: string } | { ok: false; error: string } {
  const raw = readCleanSearchParam(url, name);
  if (!raw) return { ok: true };
  if (!ISO_DATE_OR_INSTANT.test(raw)) {
    return { ok: false, error: `${name} must be an ISO date or timezone-qualified ISO timestamp` };
  }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const expanded = dateOnly
    ? `${raw}T${name === 'since' ? '00:00:00.000' : '23:59:59.999'}Z`
    : raw;
  const parsed = new Date(expanded);
  if (Number.isNaN(parsed.getTime()) || (dateOnly && parsed.toISOString().slice(0, 10) !== raw)) {
    return { ok: false, error: `${name} must be a valid ISO date or timestamp` };
  }
  return { ok: true, value: parsed.toISOString() };
}

/** Each reader fills what it understands and returns the reason it could not,
 *  so the caller stays a list of steps rather than a wall of branches. */
type FilterReader = (url: URL, filter: SearchWorkItemsFilter) => string | undefined;

const readEnumFilters: FilterReader = (url, filter) => {
  const status = readWorkItemStatusParam(url);
  if (status === null) return `status must be one of ${WORK_ITEM_STATUSES.join(', ')}`;
  if (status) filter.status = status;
  const source = readWorkItemSourceParam(url);
  if (source === null) return `source must be one of ${WORK_ITEM_SOURCES.join(', ')}`;
  if (source) filter.source = source;
  return undefined;
};

/** Plain string equality filters — nothing to reject, only to copy across. */
const readNameFilters: FilterReader = (url, filter) => {
  // `rootDepartment`: Todos whose ROOT is in that department (FR-002). A narrowing filter, so it is
  // harmless from any caller; the department-scope gate sets it on every scoped session's list.
  for (const name of ['assignee', 'department', 'createdBy', 'rootDepartment'] as const) {
    const value = readCleanSearchParam(url, name);
    if (value) filter[name] = value;
  }
  return undefined;
};

const readTextFilter: FilterReader = (url, filter) => {
  const text = readCleanSearchParam(url, 'q') ?? readCleanSearchParam(url, 'text');
  if (!text) return undefined;
  if (text.length > SEARCH_QUERY_ROUTE_CHAR_CAP) {
    return `q is too long (${text.length} chars, max ${SEARCH_QUERY_ROUTE_CHAR_CAP}) — shorten the query`;
  }
  filter.text = text;
  return undefined;
};

const readTreeFilters: FilterReader = (url, filter) => {
  for (const [name, key] of [['parent', 'parentId'], ['root', 'rootId']] as const) {
    const value = readCleanSearchParam(url, name);
    if (!value) continue;
    try {
      filter[key] = parseTodoId(value);
    } catch {
      return `${name} must be a Todo ID`;
    }
  }
  if (readCleanSearchParam(url, 'rootsOnly') === 'true') filter.rootsOnly = true;
  return undefined;
};

/** ICI-1357 `kept` and PLA-230 `home`, the board scopes. Both mirror
 *  `rootsOnly` — a boolean flag is either asserted or absent, so there is no
 *  unusable value to reject. */
const readBoardScopeFilters: FilterReader = (url, filter) => {
  if (readCleanSearchParam(url, 'kept') === 'true') filter.kept = true;
  if (readCleanSearchParam(url, 'home') === 'true') filter.home = true;
  return undefined;
};

const readLabelFilter: FilterReader = (url, filter) => {
  const label = readCleanSearchParam(url, 'label');
  if (!label) return undefined;
  // Ids pass through; display names are normalized to the stored kebab-case.
  if (/^lbl_[0-9a-f]{12}$/.test(label)) {
    filter.label = label;
    return undefined;
  }
  try {
    filter.label = normalizeLabelName(label);
  } catch {
    return 'label must be a label ID (lbl_…) or a name with at least one letter or digit';
  }
  return undefined;
};

/** `sprint` is a sprint id, a sprint name, `active` (the running sprint) or
 *  `none` (in no sprint). Names are matched case-insensitively at the query. */
const readSprintFilter: FilterReader = (url, filter) => {
  const sprint = readCleanSearchParam(url, 'sprint');
  if (!sprint) return undefined;
  if (sprint.length > 200) return 'sprint must be a sprint ID, a sprint name, active or none';
  const word = sprint.toLowerCase();
  filter.sprint = word === 'active' || word === 'none' ? word : sprint;
  return undefined;
};

const readWindowFilters: FilterReader = (url, filter) => {
  for (const name of ['since', 'until'] as const) {
    const bound = readWorkItemDateParam(url, name);
    if (!bound.ok) return bound.error;
    if (bound.value) filter[name] = bound.value;
  }
  if (filter.since && filter.until && filter.since > filter.until) {
    return 'since must be earlier than or equal to until';
  }
  return undefined;
};

const FILTER_READERS: readonly FilterReader[] = [
  readEnumFilters, readNameFilters, readTextFilter, readTreeFilters, readBoardScopeFilters, readLabelFilter, readSprintFilter, readWindowFilters,
];

export function readWorkItemQueryParams(url: URL): { ok: true; value: WorkItemQueryParams } | { ok: false; error: string } {
  const filter: SearchWorkItemsFilter = {};
  for (const read of FILTER_READERS) {
    const error = read(url, filter);
    if (error) return { ok: false, error };
  }
  const limit = readWorkItemIntegerParam(url, 'limit', WORK_ITEM_PAGE_DEFAULT_LIMIT);
  if (!limit.ok) return limit;
  const offset = readWorkItemIntegerParam(url, 'offset', 0);
  if (!offset.ok) return offset;
  return { ok: true, value: { filter, limit: limit.value, offset: offset.value } };
}
