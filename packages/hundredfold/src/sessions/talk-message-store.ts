import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "../shared/types.js";
import { initDb } from "../shared/db.js";

export interface TalkMessageInput {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  identity?: string;
  meta: JsonObject;
  toolCall?: string;
  toolId?: string;
  timestamp?: number;
}

export interface TalkMessageInsert {
  id: string;
  created: boolean;
}

function durableId(input: TalkMessageInput): string {
  if (!input.identity) return randomUUID();
  const digest = createHash("sha256").update(`${input.sessionId}\0${input.role}\0${input.identity}`).digest("hex");
  return `talk-message-${digest}`;
}

/** Insert one settled normal-chat message, deduped by provider identity. */
export function insertTalkMessage(input: TalkMessageInput): TalkMessageInsert {
  const id = durableId(input);
  const result = initDb().prepare(`INSERT OR IGNORE INTO messages
    (id, session_id, role, content, timestamp, tool_call, tool_id, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.sessionId, input.role, input.content, input.timestamp ?? Date.now(),
      input.toolCall ?? null, input.toolId ?? null, JSON.stringify(input.meta));
  return { id, created: result.changes === 1 };
}
