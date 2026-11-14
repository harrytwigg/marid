import { createHash, randomBytes } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { formatTodoId, parseTodoIdPrefix, resolveTodoIdPrefix } from "./id.js";
import { LEGACY_PORTAL_NAME } from "../shared/brand.js";
import { LEGACY_SQL_FUNCTIONS } from "../shared/legacy-names.js";

/**
 * Todo id allocation: burn an ordinal, hand back a one-time claim, and let the
 * schema's identity triggers verify that claim when the row is inserted. The
 * raw claim is never persisted — only its digest — so an id cannot be minted by
 * writing to the allocator directly.
 *
 * Kept apart from `migrate.ts` because this is the RUNTIME half of Todo
 * identity: the schema module freezes the tables and triggers, this drives them
 * on every create. `migrate.ts` re-exports all of it, so no caller had to move.
 */

const activeClaims = new WeakMap<DatabaseType, string>();
const activeClaimPrefixes = new WeakMap<DatabaseType, string>();
const registeredDatabases = new WeakSet<DatabaseType>();

function claimDigest(rawClaim: string): string {
  return createHash("sha256").update(rawClaim).digest("hex");
}

export function registerWorkItemIdentityFunctions(db: DatabaseType): void {
  if (registeredDatabases.has(db)) return;
  db.function(LEGACY_SQL_FUNCTIONS.claimDigest, () => {
    const claim = activeClaims.get(db);
    return claim ? claimDigest(claim) : null;
  });
  db.function(LEGACY_SQL_FUNCTIONS.claimPrefix, () => activeClaimPrefixes.get(db) ?? null);
  registeredDatabases.add(db);
}

function withClaim<T>(db: DatabaseType, rawClaim: string, prefix: string, fn: () => T): T {
  if (activeClaims.has(db)) throw new Error("nested Todo allocation claim");
  activeClaims.set(db, rawClaim);
  activeClaimPrefixes.set(db, prefix);
  try {
    return fn();
  } finally {
    activeClaims.delete(db);
    activeClaimPrefixes.delete(db);
  }
}

export interface WorkItemAllocationClaim {
  id: string;
  prefix: string;
  ordinal: number;
  /** One-time raw claim. It is never persisted. */
  rawClaim: string;
}

/** Commit the burn independently; a later failed create permanently leaves a gap. */
export function allocateWorkItemId(
  db: DatabaseType,
  now = new Date().toISOString(),
  prefix: string = "JIN",
): WorkItemAllocationClaim {
  registerWorkItemIdentityFunctions(db);
  parseTodoIdPrefix(prefix);
  const rawClaim = randomBytes(32).toString("hex");
  const allocation = db.transaction(() => {
    db.prepare(
      "INSERT INTO work_item_id_allocator (prefix, high_water) SELECT ?, 0 WHERE NOT EXISTS (SELECT 1 FROM work_item_id_allocator WHERE prefix = ?)",
    ).run(prefix, prefix);
    const current = db.prepare("SELECT high_water FROM work_item_id_allocator WHERE prefix = ?")
      .get(prefix) as { high_water: number };
    const next = current.high_water + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Todo ID allocator exhausted");
    return withClaim(db, rawClaim, prefix, () => {
      db.prepare("INSERT INTO work_item_id_burns (prefix, ordinal, claim_digest, burned_at) VALUES (?, ?, ?, ?)")
        .run(prefix, next, claimDigest(rawClaim), now);
      db.prepare("UPDATE work_item_id_allocator SET high_water = ? WHERE prefix = ?").run(next, prefix);
      return { prefix, ordinal: next };
    });
  }).immediate();
  return { id: formatTodoId(allocation.prefix, allocation.ordinal), ...allocation, rawClaim };
}

/** @internal test fixture builder — v1 semantics, do not use in product code. */
export function allocateWorkItemIdV1ForTest(
  db: DatabaseType,
  now = new Date().toISOString(),
  companyName: unknown = LEGACY_PORTAL_NAME,
  companyPrefix?: unknown,
): WorkItemAllocationClaim {
  registerWorkItemIdentityFunctions(db);
  const rawClaim = randomBytes(32).toString("hex");
  const allocation = db.transaction(() => {
    const current = db.prepare("SELECT prefix, high_water FROM work_item_id_allocator WHERE singleton = 1")
      .get() as { prefix: string | null; high_water: number };
    const prefix = current.prefix ?? resolveTodoIdPrefix(companyName, companyPrefix);
    const next = current.high_water + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Todo ID allocator exhausted");
    return withClaim(db, rawClaim, prefix, () => {
      db.prepare("INSERT INTO work_item_id_burns (ordinal, claim_digest, burned_at) VALUES (?, ?, ?)")
        .run(next, claimDigest(rawClaim), now);
      db.prepare("UPDATE work_item_id_allocator SET prefix = ?, high_water = ? WHERE singleton = 1")
        .run(prefix, next);
      return { prefix, ordinal: next };
    });
  }).immediate();
  return { id: formatTodoId(allocation.prefix, allocation.ordinal), ...allocation, rawClaim };
}

export function useWorkItemAllocationClaim<T>(db: DatabaseType, claim: WorkItemAllocationClaim, fn: () => T): T {
  return withClaim(db, claim.rawClaim, claim.prefix, fn);
}
