/**
 * Tables for user accounts, board grants, invite and reset tokens, member sessions and the
 * sign-in rate limiter. See docs/design/board-members.md, "Identity model".
 *
 * All additive: nothing here changes an existing table, so an older build ignores these and a
 * rollback stays bootable. Each `*_TABLE_DDL` is the single statement the boot shape verifier
 * compares byte-for-byte (whitespace aside); the `*_DDL` forms add the indexes, which are not
 * part of the verified table text.
 */

export const USERS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name    TEXT NOT NULL,
  password_hash   TEXT,
  instance_role   TEXT NOT NULL DEFAULT 'member' CHECK (instance_role IN ('member','owner')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  disabled_at     TEXT,
  password_set_at TEXT
)`;

export const BOARD_MEMBERS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS board_members (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('viewer','collaborator','owner')),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, department)
)`;

export const USER_TOKENS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS user_tokens (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  purpose       TEXT NOT NULL CHECK (purpose IN ('invite','reset')),
  email         TEXT NOT NULL,
  user_id       TEXT,
  department    TEXT,
  role          TEXT CHECK (role IS NULL OR role IN ('viewer','collaborator','owner')),
  instance_role TEXT CHECK (instance_role IS NULL OR instance_role IN ('member','owner')),
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT,
  revoked_at    TEXT
)`;

export const USER_SESSIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS user_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  user_agent   TEXT,
  ip           TEXT,
  revoked_at   TEXT
)`;

export const LOGIN_ATTEMPTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS login_attempts (
  email_or_ip TEXT NOT NULL,
  at          TEXT NOT NULL
)`;

export const USERS_DDL = `${USERS_TABLE_DDL};`;
export const BOARD_MEMBERS_DDL = `${BOARD_MEMBERS_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_board_members_department ON board_members(department);`;
export const USER_TOKENS_DDL = `${USER_TOKENS_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_user_tokens_email ON user_tokens(email);`;
export const USER_SESSIONS_DDL = `${USER_SESSIONS_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);`;
export const LOGIN_ATTEMPTS_DDL = `${LOGIN_ATTEMPTS_TABLE_DDL};
CREATE INDEX IF NOT EXISTS idx_login_attempts_key ON login_attempts(email_or_ip, at);`;

/** In creation order: board_members and user_sessions reference users. */
export const ACCOUNT_TABLES: ReadonlyArray<{ name: string; tableDdl: string; ddl: string }> = [
  { name: "users", tableDdl: USERS_TABLE_DDL, ddl: USERS_DDL },
  { name: "board_members", tableDdl: BOARD_MEMBERS_TABLE_DDL, ddl: BOARD_MEMBERS_DDL },
  { name: "user_tokens", tableDdl: USER_TOKENS_TABLE_DDL, ddl: USER_TOKENS_DDL },
  { name: "user_sessions", tableDdl: USER_SESSIONS_TABLE_DDL, ddl: USER_SESSIONS_DDL },
  { name: "login_attempts", tableDdl: LOGIN_ATTEMPTS_TABLE_DDL, ddl: LOGIN_ATTEMPTS_DDL },
];

/** Create whichever account tables are missing. Safe to call repeatedly. */
export function ensureAccountTables(db: { exec(sql: string): unknown }): void {
  for (const table of ACCOUNT_TABLES) db.exec(table.ddl);
}
