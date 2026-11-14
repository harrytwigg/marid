import type { Database } from "better-sqlite3";
import type { TalkTopic, TalkTopicKind, TalkTopicNavigation, TalkTopicState } from "./types.js";

const TOPIC_SCHEMA = `
CREATE TABLE IF NOT EXISTS talk_topics (
  id TEXT PRIMARY KEY,
  talk_session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'todo', 'workflow', 'other')),
  state TEXT NOT NULL CHECK (state IN ('active', 'warm', 'cool', 'closed')),
  label TEXT NOT NULL,
  object_anchors TEXT NOT NULL CHECK (json_valid(object_anchors)),
  goal TEXT NOT NULL,
  verified_state TEXT NOT NULL,
  decisions TEXT NOT NULL CHECK (json_valid(decisions)),
  unresolved_questions TEXT NOT NULL CHECK (json_valid(unresolved_questions)),
  retrieval_anchors TEXT NOT NULL CHECK (json_valid(retrieval_anchors)),
  raw_details TEXT NOT NULL CHECK (json_valid(raw_details)),
  transient INTEGER NOT NULL CHECK (transient IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  UNIQUE (talk_session_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_talk_topics_session_state
  ON talk_topics (talk_session_id, state, updated_at DESC);
CREATE TABLE IF NOT EXISTS talk_topic_navigation (
  talk_session_id TEXT PRIMARY KEY,
  current_topic_id TEXT,
  history_json TEXT NOT NULL CHECK (json_valid(history_json)),
  candidate_ids_json TEXT NOT NULL CHECK (json_valid(candidate_ids_json)),
  credential_generation INTEGER NOT NULL CHECK (credential_generation >= 0),
  screen_revision INTEGER NOT NULL CHECK (screen_revision >= 0),
  updated_at INTEGER NOT NULL
);
`;

function parse<T>(value: unknown): T { return JSON.parse(String(value)) as T; }

function toTopic(row: Record<string, unknown>): TalkTopic {
  return {
    id: String(row.id), talkSessionId: String(row.talk_session_id), ordinal: Number(row.ordinal),
    kind: row.kind as TalkTopicKind, state: row.state as TalkTopicState, label: String(row.label),
    objectAnchors: parse(row.object_anchors), goal: String(row.goal), verifiedState: String(row.verified_state),
    decisions: parse(row.decisions), unresolvedQuestions: parse(row.unresolved_questions),
    retrievalAnchors: parse(row.retrieval_anchors), rawDetails: parse(row.raw_details), transient: Boolean(row.transient),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    closedAt: row.closed_at === null ? null : Number(row.closed_at), revision: Number(row.revision),
  };
}

function values(topic: TalkTopic): unknown[] {
  return [
    topic.id, topic.talkSessionId, topic.ordinal, topic.kind, topic.state, topic.label,
    JSON.stringify(topic.objectAnchors), topic.goal, topic.verifiedState, JSON.stringify(topic.decisions),
    JSON.stringify(topic.unresolvedQuestions), JSON.stringify(topic.retrievalAnchors), JSON.stringify(topic.rawDetails),
    Number(topic.transient), topic.createdAt, topic.updatedAt, topic.closedAt, topic.revision,
  ];
}

export function migrateTalkTopicSchema(database: Database): void { database.exec(TOPIC_SCHEMA); }

export class TalkTopicRepository {
  constructor(private readonly database: Database) { migrateTalkTopicSchema(database); }

  get(id: string): TalkTopic | null {
    const row = this.database.prepare("SELECT * FROM talk_topics WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toTopic(row) : null;
  }

  list(talkSessionId: string): TalkTopic[] {
    const rows = this.database.prepare("SELECT * FROM talk_topics WHERE talk_session_id = ? ORDER BY ordinal")
      .all(talkSessionId) as Array<Record<string, unknown>>;
    return rows.map(toTopic);
  }

  put(topic: TalkTopic): TalkTopic {
    const result = this.database.prepare(`INSERT INTO talk_topics
      (id, talk_session_id, ordinal, kind, state, label, object_anchors, goal, verified_state, decisions,
       unresolved_questions, retrieval_anchors, raw_details, transient, created_at, updated_at, closed_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, label = excluded.label,
       object_anchors = excluded.object_anchors, goal = excluded.goal, verified_state = excluded.verified_state,
       decisions = excluded.decisions, unresolved_questions = excluded.unresolved_questions,
       retrieval_anchors = excluded.retrieval_anchors, raw_details = excluded.raw_details,
       transient = excluded.transient, updated_at = excluded.updated_at, closed_at = excluded.closed_at,
       revision = excluded.revision WHERE excluded.revision > talk_topics.revision`).run(...values(topic));
    if (result.changes !== 1) throw new Error(`Topic ${topic.id} revision did not advance.`);
    return this.get(topic.id)!;
  }

  remove(id: string): boolean {
    return this.database.prepare("DELETE FROM talk_topics WHERE id = ?").run(id).changes === 1;
  }

  replaceSession(talkSessionId: string, topics: readonly TalkTopic[]): void {
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM talk_topics WHERE talk_session_id = ?").run(talkSessionId);
      for (const topic of topics) this.put(topic);
    })();
  }

  navigation(talkSessionId: string): TalkTopicNavigation {
    const row = this.database.prepare("SELECT * FROM talk_topic_navigation WHERE talk_session_id = ?")
      .get(talkSessionId) as Record<string, unknown> | undefined;
    return row ? {
      talkSessionId,
      currentTopicId: row.current_topic_id === null ? null : String(row.current_topic_id),
      history: parse<string[]>(row.history_json),
      lastCandidateIds: parse<string[]>(row.candidate_ids_json),
      credentialGeneration: Number(row.credential_generation),
      screenRevision: Number(row.screen_revision),
      updatedAt: Number(row.updated_at),
    } : { talkSessionId, currentTopicId: null, history: [], lastCandidateIds: [], credentialGeneration: 0, screenRevision: 0, updatedAt: 0 };
  }

  saveNavigation(navigation: TalkTopicNavigation): void {
    this.database.prepare(`INSERT INTO talk_topic_navigation
      (talk_session_id, current_topic_id, history_json, candidate_ids_json, credential_generation, screen_revision, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(talk_session_id) DO UPDATE SET current_topic_id = excluded.current_topic_id,
        history_json = excluded.history_json, candidate_ids_json = excluded.candidate_ids_json,
        credential_generation = excluded.credential_generation, screen_revision = excluded.screen_revision,
        updated_at = excluded.updated_at`)
      .run(navigation.talkSessionId, navigation.currentTopicId, JSON.stringify(navigation.history),
        JSON.stringify(navigation.lastCandidateIds), navigation.credentialGeneration, navigation.screenRevision, navigation.updatedAt);
  }
}
