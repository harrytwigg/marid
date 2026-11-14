import type { Database } from "better-sqlite3";

const TALK_SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS talk_sessions (
  id TEXT PRIMARY KEY,
  browser_instance_id TEXT NOT NULL,
  credential_generation INTEGER NOT NULL CHECK (credential_generation >= 1),
  session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live', 'parked', 'closed')),
  model TEXT NOT NULL,
  brief TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  truncated_turns INTEGER NOT NULL CHECK (truncated_turns >= 0),
  token_expires_at INTEGER NOT NULL,
  exposed_tools_json TEXT NOT NULL CHECK (json_valid(exposed_tools_json)),
  expanded_intents_json TEXT NOT NULL CHECK (json_valid(expanded_intents_json)) -- readerless, always '[]': IF NOT EXISTS cannot retro-relax NOT NULL in the shared registry.db
);

CREATE TABLE IF NOT EXISTS talk_session_turns (
  talk_session_id TEXT NOT NULL REFERENCES talk_sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  visual_receipts_json TEXT NOT NULL CHECK (json_valid(visual_receipts_json)),
  PRIMARY KEY (talk_session_id, ordinal)
);

CREATE TABLE IF NOT EXISTS talk_session_actions (
  talk_session_id TEXT NOT NULL REFERENCES talk_sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  id TEXT NOT NULL,
  at INTEGER NOT NULL,
  tool TEXT NOT NULL,
  subject TEXT,
  lane TEXT NOT NULL CHECK (lane IN ('fast', 'consent')),
  consent TEXT NOT NULL CHECK (consent IN ('not-required', 'granted', 'refused')),
  undo_of TEXT,
  PRIMARY KEY (talk_session_id, ordinal),
  UNIQUE (talk_session_id, id)
);

CREATE TABLE IF NOT EXISTS talk_session_interruptions (
  talk_session_id TEXT NOT NULL REFERENCES talk_sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'speech_interruption'),
  vad_type TEXT NOT NULL CHECK (vad_type IN ('server_vad', 'semantic_vad')),
  cancelled_by TEXT NOT NULL CHECK (cancelled_by = 'provider'),
  recovered INTEGER NOT NULL CHECK (recovered IN (0, 1)),
  speech_ms INTEGER CHECK (speech_ms IS NULL OR (speech_ms >= 0 AND speech_ms <= 600000)),
  PRIMARY KEY (talk_session_id, ordinal)
);

CREATE TABLE IF NOT EXISTS talk_session_visual_receipt_keys (
  talk_session_id TEXT NOT NULL REFERENCES talk_sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  receipt_key TEXT NOT NULL,
  PRIMARY KEY (talk_session_id, ordinal),
  UNIQUE (talk_session_id, receipt_key)
);

CREATE TABLE IF NOT EXISTS talk_tool_receipts (
  talk_session_id TEXT NOT NULL,
  provider_call_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (talk_session_id, provider_call_id)
);

CREATE INDEX IF NOT EXISTS idx_talk_sessions_state_seen
  ON talk_sessions (state, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_talk_sessions_chat
  ON talk_sessions (session_id, opened_at);
`;

export function migrateTalkSessionSchema(database: Database): void {
  database.exec(TALK_SESSION_SCHEMA);
}
