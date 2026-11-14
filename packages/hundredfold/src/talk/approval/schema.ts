import type { Database } from "better-sqlite3";

const TALK_APPROVAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS talk_voice_transcripts (
  talk_session_id TEXT NOT NULL,
  browser_instance_id TEXT NOT NULL,
  credential_generation INTEGER NOT NULL CHECK (credential_generation >= 1),
  input_ordinal INTEGER NOT NULL CHECK (input_ordinal >= 1),
  provider_item_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  transcript TEXT NOT NULL CHECK (length(transcript) BETWEEN 1 AND 4000),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (talk_session_id, credential_generation, provider_item_id),
  UNIQUE (talk_session_id, credential_generation, provider_event_id),
  UNIQUE (talk_session_id, credential_generation, input_ordinal)
);

CREATE TABLE IF NOT EXISTS talk_approval_challenges (
  id TEXT PRIMARY KEY,
  talk_session_id TEXT NOT NULL,
  operator_principal TEXT NOT NULL,
  browser_instance_id TEXT NOT NULL,
  credential_generation INTEGER NOT NULL CHECK (credential_generation >= 1),
  prepare_provider_call_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  prepared_after_ordinal INTEGER NOT NULL CHECK (prepared_after_ordinal >= 1),
  todo_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  approval_fingerprint TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json) AND json_type(scope_json) = 'object'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'expired')),
  committed_at INTEGER,
  UNIQUE (talk_session_id, credential_generation, prepare_provider_call_id)
);

CREATE TABLE IF NOT EXISTS talk_approval_audit (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  talk_session_id TEXT NOT NULL,
  operator_principal TEXT NOT NULL,
  browser_instance_id TEXT NOT NULL,
  credential_generation INTEGER NOT NULL CHECK (credential_generation >= 1),
  provider_call_id TEXT NOT NULL,
  provider_tool_item_id TEXT,
  provider_tool_event_id TEXT,
  provider_transcript_item_id TEXT,
  provider_transcript_event_id TEXT,
  request_fingerprint TEXT NOT NULL,
  transcript TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('committed', 'refused')),
  code TEXT NOT NULL,
  result TEXT NOT NULL CHECK (json_valid(result) AND json_type(result) = 'object'),
  created_at INTEGER NOT NULL,
  UNIQUE (talk_session_id, credential_generation, provider_call_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_talk_approval_committed_transcript
  ON talk_approval_audit (talk_session_id, credential_generation, provider_transcript_item_id)
  WHERE outcome = 'committed' AND provider_transcript_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_talk_approval_audit_challenge
  ON talk_approval_audit (challenge_id, created_at);
CREATE INDEX IF NOT EXISTS idx_talk_approval_challenge_expiry
  ON talk_approval_challenges (status, expires_at);
`;

export function migrateTalkApprovalSchema(database: Database): void {
  database.exec(TALK_APPROVAL_SCHEMA);
}
