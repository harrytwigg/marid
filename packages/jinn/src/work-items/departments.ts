import fs from "node:fs";
import type { Database as DatabaseType } from "better-sqlite3";
import { loadConfig } from "../shared/config.js";
import { CONFIG_PATH } from "../shared/paths.js";
import { DepartmentBoundaryError, isNonOpenDepartment } from "./department-scope.js";
import { deriveTodoIdPrefix, resolveTodoIdPrefix } from "./id.js";
import type { WorkItem } from "./store.js";

/**
 * Per-department Todo ID prefixes (Todos v2 slice 1). A department's prefix is
 * derived once, registered in the `departments` table (Task 3), and never
 * changes; items keep their birth prefix even if they later move departments.
 */

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Derive the 3-letter candidate for a department slug. Falls back to X-padding
 *  for short/letterless slugs instead of throwing like the company derivation. */
export function derivePrefixCandidate(slug: string): string {
  try {
    return deriveTodoIdPrefix(slug);
  } catch {
    const letters = slug.toUpperCase().replace(/[^A-Z]/g, "");
    return `${letters}XXX`.slice(0, 3);
  }
}

/** Deterministic collision fallback: try the candidate, then advance the third
 *  letter A→Z, then the second, then the first. Throws only if every variant of
 *  all three positions is taken (78 tries — practically impossible). */
export function pickFreePrefix(candidate: string, taken: ReadonlySet<string>): string {
  if (!taken.has(candidate)) return candidate;
  for (let position = 2; position >= 0; position--) {
    for (const letter of LETTERS) {
      const attempt = candidate.slice(0, position) + letter + candidate.slice(position + 1);
      if (!taken.has(attempt)) return attempt;
    }
  }
  throw new Error(`no free Todo ID prefix near ${candidate}`);
}

/** Resolve (lazily registering) the immutable ID prefix for a department slug.
 *  `reservedCompanyPrefix` is the company namespace and can never be assigned
 *  to a department. Registration races resolve via the UNIQUE constraint. */
export function resolveDepartmentPrefix(db: DatabaseType, slug: string, reservedCompanyPrefix: string): string {
  const existing = db.prepare("SELECT prefix FROM departments WHERE slug = ?").get(slug) as { prefix: string } | undefined;
  if (existing) return existing.prefix;
  const taken = new Set(db.prepare("SELECT prefix FROM departments").pluck().all() as string[]);
  // Every allocated namespace is reserved too — a retired company prefix keeps
  // its history and must never be silently claimed by a department (two
  // semantically different sequences would interleave under one prefix).
  for (const allocated of db.prepare("SELECT prefix FROM work_item_id_allocator").pluck().all() as string[]) {
    taken.add(allocated);
  }
  taken.add(reservedCompanyPrefix);
  const prefix = pickFreePrefix(derivePrefixCandidate(slug), taken);
  try {
    db.prepare("INSERT INTO departments (slug, prefix, created_at) VALUES (?, ?, ?)")
      .run(slug, prefix, new Date().toISOString());
    return prefix;
  } catch (err) {
    // Only a constraint collision means we lost a registration race; anything
    // else (I/O, readonly, …) must surface instead of recursing forever.
    const code = (err as { code?: string } | null)?.code;
    if (code !== "SQLITE_CONSTRAINT_UNIQUE" && code !== "SQLITE_CONSTRAINT_PRIMARYKEY") throw err;
    const winner = db.prepare("SELECT prefix FROM departments WHERE slug = ?").get(slug) as { prefix: string } | undefined;
    if (winner) return winner.prefix;
    return resolveDepartmentPrefix(db, slug, reservedCompanyPrefix);
  }
}

export interface DepartmentRecord { slug: string; prefix: string; createdAt: string }

export interface DepartmentSummary extends DepartmentRecord {
  /** Live count of Todos currently IN the department (items keep their birth
   *  prefix when moved, so this counts membership, not the ID namespace). */
  todoCount: number;
  /** False for a registered department outside `gateway.todoDepartments`:
   *  its Todos still carry its prefix, but nothing new may be put in it. */
  selectable: boolean;
}

/** The `GET /api/departments` surface: registry rows + one GROUP BY count.
 *  `allowed` is the closed department policy, when one is configured. */
export function listDepartmentsWithCounts(db: DatabaseType, allowed?: readonly string[] | null): DepartmentSummary[] {
  return (
    db
      .prepare(
        `SELECT d.slug, d.prefix, d.created_at, COUNT(w.id) AS todo_count
         FROM departments d
         LEFT JOIN work_items w ON w.department = d.slug
         GROUP BY d.slug
         ORDER BY d.slug`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => ({
    slug: row.slug as string,
    prefix: row.prefix as string,
    createdAt: row.created_at as string,
    todoCount: Number(row.todo_count),
    selectable: !allowed || allowed.includes(row.slug as string),
  }));
}

/** Live spend per department: `SUM(total_cost)` over the sessions linked to its Todos. A Todo's department is its root's (FR-002), so a sub-task counts toward its root's department. */
export function departmentSpend(db: DatabaseType): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT r.department AS department, COALESCE(SUM(s.total_cost), 0) AS spend
         FROM work_items w
         JOIN work_items r ON r.id = w.root_id
         JOIN sessions s ON s.work_item_id = w.id
        WHERE r.department IS NOT NULL
        GROUP BY r.department`,
    )
    .all() as Array<{ department: string; spend: number }>;
  return new Map(rows.map((row) => [row.department, row.spend]));
}

/**
 * Register any department that holds Todos but is missing from the registry
 * (review F2). Department-changing writes now mint the row in their own
 * transaction; this reconciles rows written BEFORE that fix (move-only
 * departments). Idempotent — runs on every boot.
 */
export function reconcileDepartmentRegistry(db: DatabaseType): number {
  const missing = db
    .prepare(
      "SELECT DISTINCT department FROM work_items WHERE department IS NOT NULL AND department NOT IN (SELECT slug FROM departments) ORDER BY department",
    )
    .pluck()
    .all() as string[];
  if (missing.length === 0) return 0;
  const portal = fs.existsSync(CONFIG_PATH) ? loadConfig().portal : undefined;
  const companyPrefix = resolveTodoIdPrefix(portal?.companyName ?? "Jinn", portal?.companyPrefix);
  for (const slug of missing) {
    resolveDepartmentPrefix(db, slug, companyPrefix);
  }
  return missing.length;
}

/**
 * The department a new sub-task lands in. A sub-task shares its root's department
 * whenever either side is not open, so a create that names another department
 * across that boundary is refused. Between open departments nothing changes: a
 * sub-task may still name its own, and otherwise inherits its parent's.
 *
 * Lives in the store's create path, not in a route, because plugin and cron creates
 * pass a draft straight through.
 */
export function resolveSubtaskDepartment(
  parent: WorkItem | undefined,
  named: string | null | undefined,
  getItem: (id: string) => WorkItem | undefined,
): string | null {
  if (!parent) return named ?? null;
  const root = parent.rootId === parent.id ? parent : getItem(parent.rootId) ?? parent;
  const inherited = named === undefined ? parent.department : named;
  if (!isNonOpenDepartment(root.department) && !isNonOpenDepartment(inherited)) return inherited;
  if (named !== undefined && named !== root.department) throw boundaryRefusal(root, named);
  return root.department;
}

function boundaryRefusal(root: WorkItem, named: string | null): DepartmentBoundaryError {
  const where = root.department ? `department "${root.department}"` : 'the company';
  const target = named ? `department "${named}"` : 'the company';
  return new DepartmentBoundaryError(`a sub-task of ${root.id} stays in ${where}: it cannot be created in ${target} because one of them is scoped`);
}
