import type { IncomingMessage, ServerResponse } from "node:http";
import { initDb } from "../shared/db.js";
import { getSession, updateSession } from "../sessions/registry.js";
import { insertTalkMessage } from "../sessions/talk-message-store.js";
import { TalkApprovalRepository } from "../talk/approval/repository.js";
import type { TalkSession } from "../talk/session/types.js";
import { readJsonBody } from "./http-helpers.js";

interface Options {
  send: (res: ServerResponse, status: number, body: unknown) => void;
}

const bounded = (value: unknown, max = 200): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function validEvidence(body: Record<string, unknown>): boolean {
  const boundedFields = [body.browserInstanceId, body.providerItemId, body.providerEventId];
  return boundedFields.every((value) => bounded(value))
    && Number.isInteger(body.credentialGeneration) && bounded(body.transcript, 4000);
}

function matchesSession(body: Record<string, unknown>, session: TalkSession): boolean {
  return body.browserInstanceId === session.browserInstanceId && body.credentialGeneration === session.credentialGeneration;
}

function titleNormalTalkChat(sessionId: string, transcript: string, at: number): void {
  if (!getSession(sessionId)?.title?.startsWith("#")) return;
  const flat = transcript.replace(/\s+/g, " ").trim();
  updateSession(sessionId, { title: `Talk · ${flat.slice(0, 54)}`, lastActivity: new Date(at).toISOString() });
}

export async function handleTalkTranscript(
  req: IncomingMessage,
  res: ServerResponse,
  session: TalkSession,
  options: Options,
): Promise<void> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const body = (parsed.body ?? {}) as Record<string, unknown>;
  if (!validEvidence(body)) {
    options.send(res, 400, { error: "Bounded browser, generation, provider item/event, and transcript evidence are required." });
    return;
  }
  if (!matchesSession(body, session)) {
    options.send(res, 409, { error: "Transcript evidence does not match the active browser credential generation." });
    return;
  }
  try {
    const at = Date.now();
    const transcript = String(body.transcript);
    const database = initDb();
    const evidence = database.transaction(() => {
      const recorded = new TalkApprovalRepository(database).recordTranscript({
        talkSessionId: session.id,
        browserInstanceId: session.browserInstanceId,
        credentialGeneration: session.credentialGeneration,
        providerItemId: String(body.providerItemId),
        providerEventId: String(body.providerEventId),
        transcript,
        recordedAt: at,
      });
      const message = insertTalkMessage({
        sessionId: session.sessionId,
        role: "user",
        content: transcript,
        identity: `input:${session.credentialGeneration}:${recorded.providerItemId}`,
        timestamp: at,
        meta: { talk: { kind: "transcript", talkSessionId: session.id, credentialGeneration: session.credentialGeneration,
          providerItemId: recorded.providerItemId, providerEventId: recorded.providerEventId } },
      });
      if (message.created) titleNormalTalkChat(session.sessionId, transcript, at);
      return recorded;
    })();
    options.send(res, 200, { ok: true, inputOrdinal: evidence.inputOrdinal });
  } catch (error) {
    options.send(res, 409, { error: error instanceof Error ? error.message : "Transcript evidence conflicted." });
  }
}
