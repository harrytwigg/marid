import type { IncomingMessage, ServerResponse } from "node:http";
import { initDb } from "../shared/db.js";
import { TalkProactiveRepository } from "../talk/proactive/repository.js";
import { TalkProactiveService } from "../talk/proactive/service.js";
import { readJsonBody } from "./http-helpers.js";
import { json } from "./route-helpers.js";
import type { CallerIdentity } from "./session-comm-guards.js";

function pathSession(pathname: string): string | null {
  const match = /^\/api\/talk\/proactive\/([^/]+)\/ack$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

function authorize(res: ServerResponse, caller: CallerIdentity): boolean {
  if (caller.kind === "operator") return true;
  json(res, { error: "Talk proactive acknowledgment requires operator authentication." }, caller.kind === "unauthenticated" ? 401 : 403);
  return false;
}

function acknowledgment(body: Record<string, unknown>): { receiptId: string; outcome: "completed" | "interrupted" } | null {
  const receiptId = body.receiptId;
  const outcome = body.outcome;
  const validOutcome = outcome === "completed" || outcome === "interrupted";
  return typeof receiptId === "string" && receiptId.length > 0 && receiptId.length <= 200 && validOutcome
    ? { receiptId, outcome }
    : null;
}

export async function handleTalkProactiveApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  caller: CallerIdentity,
): Promise<boolean> {
  const talkSessionId = pathSession(pathname);
  if (talkSessionId === null || req.method !== "POST") return false;
  if (!authorize(res, caller)) return true;
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return true;
  const input = acknowledgment((parsed.body ?? {}) as Record<string, unknown>);
  if (!input) {
    json(res, { error: "A bounded receiptId and completed or interrupted outcome are required." }, 400);
    return true;
  }
  try {
    const service = new TalkProactiveService(new TalkProactiveRepository(initDb()));
    json(res, { receipt: service.acknowledge(talkSessionId, input.receiptId, input.outcome) });
  } catch (error) {
    json(res, { error: error instanceof Error ? error.message : String(error) }, 404);
  }
  return true;
}
