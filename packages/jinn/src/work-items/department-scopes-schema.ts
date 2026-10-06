/** The last scope each department loaded with. A refused or deleted `department.yaml`
 *  keeps this value, so a broken file never opens a scoped department.
 *
 *  An additive table, never a column on `departments` or `work_items`: the exact-shape
 *  verifier refuses drift in an existing table, so a new table is the only extension a
 *  deployed database survives, and an older build simply ignores it. */
export const DEPARTMENT_SCOPES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS department_scopes (
  slug        TEXT PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('open','scoped','dedicated')),
  recorded_at TEXT NOT NULL
)`;

export const DEPARTMENT_SCOPES_DDL = `${DEPARTMENT_SCOPES_TABLE_DDL};`;
