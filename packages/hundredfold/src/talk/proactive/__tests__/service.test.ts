import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { TalkProactiveRepository } from "../repository.js";
import { TalkProactiveService } from "../service.js";
import type { ProactiveCuePayload, ProactiveSignal } from "../types.js";

const NOW = 1_800_000_000_000;

function signal(overrides: Partial<ProactiveSignal> = {}): ProactiveSignal {
  return {
    eventId: "event-1", dedupeKey: "todo:todo-1:2", talkSessionId: "talk-1", topicId: "topic-1",
    source: "todo", subjectId: "todo-1", severity: "info", blocking: false, requiresOperator: false,
    summary: "A related Todo changed.", uiEffect: { type: "refresh", target: "todo:todo-1" }, occurredAt: NOW,
    ...overrides,
  };
}

function setup(now: { value: number } = { value: NOW }) {
  const database = new Database(":memory:");
  const repository = new TalkProactiveRepository(database);
  const service = new TalkProactiveService(repository, () => now.value);
  const context = { activeTopicId: "topic-1", knownTopicIds: ["topic-1"], lastSpokenAt: null };
  return { database, repository, service, context, now };
}

describe("TalkProactiveService", () => {
  it("delivers one quiet cue for duplicate event and dedupe identities", () => {
    const { database, repository, service, context } = setup();
    const delivered: ProactiveCuePayload[] = [];
    const first = service.handle(signal(), context, (cue) => delivered.push(cue));
    const replay = service.handle(signal({ eventId: "event-2" }), context, (cue) => delivered.push(cue));

    expect(first.status).toBe("delivered");
    expect(replay.status).toBe("replayed");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ disposition: "quiet", urgency: "routine", summary: "A related Todo changed." });
    expect(repository.list("talk-1")).toHaveLength(1);
    database.close();
  });

  it("speaks one urgent active-topic cue and records interruption once", () => {
    const { database, repository, service, context } = setup();
    const deliver = vi.fn();
    const input = signal({ severity: "critical", blocking: true });
    const first = service.handle(input, context, deliver);
    const replay = service.handle(input, context, deliver);

    expect(first.receipt).toMatchObject({ disposition: "spoken", urgency: "urgent", interruptionState: "requested" });
    expect(replay.status).toBe("replayed");
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(service.recordInterruption(first.receipt.id, "interrupted")).toMatchObject({ interruptionState: "interrupted" });
    expect(service.recordInterruption(first.receipt.id, "interrupted")).toMatchObject({ interruptionState: "interrupted" });
    expect(repository.list("talk-1")).toHaveLength(1);
    database.close();
  });

  it("retries the durable first payload after backoff without minting a second receipt", () => {
    const { database, repository, service, context, now } = setup();
    const delivered: ProactiveCuePayload[] = [];
    const failing = service.handle(signal(), context, () => { throw new Error("network unavailable"); });
    expect(failing).toMatchObject({ status: "retryable", receipt: { attempts: 1 } });

    expect(service.handle(signal({ summary: "modified retry" }), context, (cue) => delivered.push(cue)).status).toBe("deferred");
    now.value += 1_000;
    const recovered = service.handle(signal({ eventId: "event-2", summary: "modified retry" }), context, (cue) => delivered.push(cue));
    expect(recovered).toMatchObject({ status: "delivered", receipt: { attempts: 2 } });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.summary).toBe("A related Todo changed.");
    expect(repository.list("talk-1")).toHaveLength(1);
    database.close();
  });

  it("keeps delivered dedupe durable across repository instances", () => {
    const database = new Database(":memory:");
    const first = new TalkProactiveService(new TalkProactiveRepository(database), () => NOW);
    const context = { activeTopicId: "topic-1", knownTopicIds: ["topic-1"], lastSpokenAt: null };
    expect(first.handle(signal(), context, () => undefined).status).toBe("delivered");
    const deliver = vi.fn();
    const second = new TalkProactiveService(new TalkProactiveRepository(database), () => NOW + 60_000);
    expect(second.handle(signal(), context, deliver).status).toBe("replayed");
    expect(deliver).not.toHaveBeenCalled();
    database.close();
  });

  it("stops retrying after three failed delivery attempts", () => {
    const { database, repository, service, context, now } = setup();
    const fail = vi.fn(() => { throw new Error("offline"); });
    expect(service.handle(signal(), context, fail).status).toBe("retryable");
    now.value += 1_000;
    expect(service.handle(signal(), context, fail).status).toBe("retryable");
    now.value += 1_000;
    expect(service.handle(signal(), context, fail).status).toBe("failed");
    now.value += 60_000;
    expect(service.handle(signal(), context, fail).status).toBe("replayed");
    expect(fail).toHaveBeenCalledTimes(3);
    expect(repository.list("talk-1")).toHaveLength(1);
    database.close();
  });

  it("lists delivered cues until the browser acknowledges their outcome", () => {
    const { database, service, context } = setup();
    const delivered = service.handle(signal({ severity: "critical", blocking: true }), context, () => undefined);
    expect(service.pendingCues("talk-1")).toEqual([expect.objectContaining({ receiptId: delivered.receipt.id })]);
    expect(service.acknowledge("talk-1", delivered.receipt.id, "interrupted")).toMatchObject({
      interruptionState: "interrupted",
      acknowledgedAt: NOW,
    });
    expect(service.acknowledge("talk-1", delivered.receipt.id, "interrupted")).toMatchObject({ acknowledgedAt: NOW });
    expect(service.pendingCues("talk-1")).toEqual([]);
    database.close();
  });
});
