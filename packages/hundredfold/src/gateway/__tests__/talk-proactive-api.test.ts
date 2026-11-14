import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TalkProactiveRepository } from "../../talk/proactive/repository.js";
import { TalkProactiveService } from "../../talk/proactive/service.js";
import {
  baseConfig, call, dbModule, operatorHeaders, stubMintingFetch,
} from "./helpers/talk-route-harness.js";

const NOW = 1_800_000_000_000;

beforeEach(() => { stubMintingFetch(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Talk proactive catch-up API", () => {
  it("returns an unacknowledged cue after reload and clears it after operator acknowledgment", async () => {
    const config = baseConfig();
    const opened = await call(config, "POST", "/api/talk/sessions", { browserInstanceId: "browser-proactive" });
    const talkSessionId = String(opened.body.id);
    const service = new TalkProactiveService(new TalkProactiveRepository(dbModule.initDb()), () => NOW);
    const delivered = service.handle({
      eventId: "event-reload", dedupeKey: "todo:reload:1", talkSessionId, topicId: "topic-reload",
      source: "todo", subjectId: "todo-reload", severity: "info", blocking: false, requiresOperator: false,
      summary: "A related Todo changed.", uiEffect: { type: "refresh", target: "todo:todo-reload" }, occurredAt: NOW,
    }, { activeTopicId: "topic-reload", knownTopicIds: ["topic-reload"] }, () => undefined);

    const reloaded = await call(config, "GET", `/api/talk/sessions/${talkSessionId}`);
    expect(reloaded.body.proactiveCues).toEqual([expect.objectContaining({ receiptId: delivered.receipt.id })]);
    expect((await call(config, "POST", `/api/talk/proactive/${talkSessionId}/ack`, {
      receiptId: delivered.receipt.id, outcome: "completed",
    }, {})).status).toBe(401);
    expect((await call(config, "POST", `/api/talk/proactive/${talkSessionId}/ack`, {
      receiptId: "", outcome: "completed",
    }, operatorHeaders)).status).toBe(400);
    expect((await call(config, "POST", `/api/talk/proactive/${talkSessionId}/ack`, {
      receiptId: delivered.receipt.id, outcome: "completed",
    }, operatorHeaders)).status).toBe(200);
    const settled = await call(config, "GET", `/api/talk/sessions/${talkSessionId}`);
    expect(settled.body.proactiveCues).toEqual([]);
  });
});
