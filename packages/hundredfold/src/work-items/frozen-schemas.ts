/**
 * Every `work_items` shape this release can still FIND on disk, frozen: the v1
 * public release, the pre-ownership-move v2 with shadowed approval columns, and the
 * unreleased prerelease shell. Startup recognizes a database by matching its
 * stored DDL against these byte-for-byte, so none of them may ever be edited to
 * follow the live schema — an edit here silently stops recognizing the databases
 * it describes.
 *
 * The live v2 shape stays in `migrate.ts` with the migration that maintains it.
 */

/** The canonical-id CHECK, shared by every shape above and by the live one.
 *  Kept beside the frozen shapes because they are its oldest consumers; the SQL
 *  spelling of the rule `id.ts` enforces in TypeScript. */
export const CANONICAL_ID_SQL = `
  id GLOB '[A-Z][A-Z][A-Z]-[1-9]*'
  AND substr(id, 5) NOT GLOB '*[^0-9]*'
  AND CAST(substr(id, 5) AS INTEGER) BETWEEN 1 AND 9007199254740991
  AND printf('%lld', CAST(substr(id, 5) AS INTEGER)) = substr(id, 5)
`;

/** v1 (first public Todo release) work_items shape, byte-identical to what it
 *  installed — the v1→v2 migration recognizes existing databases against it. */
export const V1_WORK_ITEMS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_items (
  id                  TEXT PRIMARY KEY CHECK (${CANONICAL_ID_SQL}),
  title               TEXT NOT NULL,
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department          TEXT,
  assignee            TEXT,
  priority            INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  rank                REAL,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  source              TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','delegation','cron','workflow','session','connector','goal')),
  source_ref          TEXT,
  acceptance          TEXT,
  verify_policy       TEXT,
  rounds              INTEGER NOT NULL DEFAULT 0,
  budget_usd          REAL,
  approval_state      TEXT CHECK (approval_state IN ('pending','approved','rejected')),
  approval_request    TEXT,
  approval_ref        TEXT,
  approval_target     TEXT,
  approval_target_kind TEXT CHECK (approval_target_kind IN ('employee','virtual','none')),
  approval_escalated_at TEXT,
  approval_decided_by TEXT,
  approval_decided_at TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  closed_at           TEXT
)`;

export const V1_WORK_ITEM_ID_ALLOCATOR_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_allocator (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  prefix TEXT CHECK (prefix IS NULL OR (length(prefix) = 3 AND prefix GLOB '[A-Z][A-Z][A-Z]')),
  high_water INTEGER NOT NULL CHECK (high_water BETWEEN 0 AND 9007199254740991)
)
`;

export const V1_WORK_ITEM_ID_BURNS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_burns (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  claim_digest TEXT NOT NULL UNIQUE CHECK (length(claim_digest) = 64 AND claim_digest NOT GLOB '*[^0-9a-f]*'),
  burned_at TEXT NOT NULL
)
`;

export const V1_WORK_ITEM_ID_ISSUANCES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_id_issuances (
  ordinal INTEGER PRIMARY KEY CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  issued_at TEXT NOT NULL
)
`;

export const V1_WORK_ITEM_IDENTITY_TABLES_DDL = `
${V1_WORK_ITEM_ID_ALLOCATOR_TABLE_DDL};
INSERT INTO work_item_id_allocator (singleton, prefix, high_water)
  SELECT 1, NULL, 0 WHERE NOT EXISTS (SELECT 1 FROM work_item_id_allocator);
${V1_WORK_ITEM_ID_BURNS_TABLE_DDL};
${V1_WORK_ITEM_ID_ISSUANCES_TABLE_DDL};
`;

/** Pre-ownership-move v2 work_items shape, when approvals were also shadowed in eight
 *  columns here. Frozen recognizer: a match is healed at boot. */
export const V2_APPROVAL_WORK_ITEMS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_items (
  id                  TEXT PRIMARY KEY CHECK (${CANONICAL_ID_SQL}),
  title               TEXT NOT NULL,
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department          TEXT,
  assignee            TEXT,
  created_by          TEXT NOT NULL,
  parent_id           TEXT REFERENCES work_items(id),
  root_id             TEXT NOT NULL,
  depth               INTEGER NOT NULL DEFAULT 0 CHECK ((parent_id IS NULL AND depth = 0) OR (parent_id IS NOT NULL AND depth BETWEEN 1 AND 3)),
  due_at              TEXT,
  priority            INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  rank                REAL,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  source              TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','delegation','cron','workflow','session','connector','goal')),
  source_ref          TEXT,
  acceptance          TEXT,
  verify_policy       TEXT,
  rounds              INTEGER NOT NULL DEFAULT 0,
  budget_usd          REAL,
  approval_state      TEXT CHECK (approval_state IN ('pending','approved','rejected')),
  approval_request    TEXT,
  approval_ref        TEXT,
  approval_target     TEXT,
  approval_target_kind TEXT CHECK (approval_target_kind IN ('employee','virtual','none')),
  approval_escalated_at TEXT,
  approval_decided_by TEXT,
  approval_decided_at TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  closed_at           TEXT
)`;

/** The unreleased `wi_*` shape — the only prerelease table startup recognizes,
 *  and only while it is empty. */
export const PRERELEASE_WORK_ITEMS_TABLE_SQL = `
CREATE TABLE work_items (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT,
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','assigned','executing','in_review','done','blocked','escalated','cancelled')),
  department TEXT, assignee TEXT, priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  rank REAL, version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  source TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','delegation','cron','workflow','session','connector','goal')),
  source_ref TEXT, acceptance TEXT, verify_policy TEXT, rounds INTEGER NOT NULL DEFAULT 0, budget_usd REAL,
  approval_state TEXT CHECK (approval_state IN ('pending','approved','rejected')), approval_request TEXT, approval_ref TEXT,
  approval_target TEXT, approval_target_kind TEXT CHECK (approval_target_kind IN ('employee','virtual','none')),
  approval_escalated_at TEXT, approval_decided_by TEXT, approval_decided_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
)`;
