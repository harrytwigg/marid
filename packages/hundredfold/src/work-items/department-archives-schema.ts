/** Archived departments: a row means the department takes no new Todos and leaves the
 *  pickers. Its registry row in `departments` stays, so its prefix stays reserved and its
 *  Todos keep their ids.
 *
 *  An additive table, never a column on `departments`, for the reason `department_scopes`
 *  gives: the exact-shape verifier refuses drift in an existing table, so a new table is the
 *  only extension a deployed database survives, and an older build simply ignores it. */
export const DEPARTMENT_ARCHIVES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS department_archives (
  slug        TEXT PRIMARY KEY REFERENCES departments(slug),
  archived_at TEXT NOT NULL
)`;

export const DEPARTMENT_ARCHIVES_DDL = `${DEPARTMENT_ARCHIVES_TABLE_DDL};`;
