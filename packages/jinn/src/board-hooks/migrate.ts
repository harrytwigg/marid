import type Database from "better-sqlite3";

const BOARD_HOOKS_DDL = `
CREATE TABLE IF NOT EXISTS board_hook_runs (
  id TEXT PRIMARY KEY,
  fire_id TEXT NOT NULL,
  hook TEXT NOT NULL,
  event TEXT NOT NULL,
  event_id TEXT NOT NULL,
  todo_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('spawn', 'command', 'notify', 'none')),
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error', 'suppressed', 'interrupted')),
  session_id TEXT,
  exit_code INTEGER,
  error TEXT,
  output TEXT,
  payload TEXT NOT NULL,
  chain TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  started_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_board_hook_runs_recent ON board_hook_runs(started_ms);
CREATE INDEX IF NOT EXISTS idx_board_hook_runs_hook ON board_hook_runs(hook, started_ms);
CREATE INDEX IF NOT EXISTS idx_board_hook_runs_todo ON board_hook_runs(todo_id, started_ms);
CREATE INDEX IF NOT EXISTS idx_board_hook_runs_fire ON board_hook_runs(fire_id);
`;

export function migrateBoardHooksSchema(db: Database.Database): void {
  db.exec(BOARD_HOOKS_DDL);
}
