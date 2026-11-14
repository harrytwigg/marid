import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TalkTopicRepository } from "../repository.js";
import type { TalkTopic } from "../types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function durableTopic(): TalkTopic {
  return {
    id: "topic-release",
    talkSessionId: "talk-normal-chat",
    ordinal: 12,
    kind: "workflow",
    state: "warm",
    label: "Release checklist",
    objectAnchors: [{ kind: "workflow", id: "release-flow", relation: "current-run" }],
    goal: "Ship the release safely",
    verifiedState: "Waiting for review",
    decisions: ["Keep the staged rollout"],
    unresolvedQuestions: ["Who verifies the final artifact?"],
    retrievalAnchors: ["/workflows/release-flow/runs/run-12"],
    rawDetails: ["The current node is review"],
    transient: false,
    createdAt: 100,
    updatedAt: 200,
    closedAt: null,
    revision: 3,
  };
}

describe("TalkTopicRepository", () => {
  it("survives a new database and repository instance", () => {
    const root = mkdtempSync(join(tmpdir(), "hundredfold-talk-topics-"));
    roots.push(root);
    const path = join(root, "sessions.db");
    const firstDb = new Database(path);
    const first = new TalkTopicRepository(firstDb);
    first.put(durableTopic());
    firstDb.close();

    const secondDb = new Database(path);
    const second = new TalkTopicRepository(secondDb);
    expect(second.get("topic-release")).toEqual(durableTopic());
    expect(second.list("talk-normal-chat")).toEqual([durableTopic()]);
    secondDb.close();
  });

  it("updates a topic only when its revision advances", () => {
    const db = new Database(":memory:");
    const repository = new TalkTopicRepository(db);
    const original = durableTopic();
    repository.put(original);
    expect(() => repository.put({ ...original, verifiedState: "stale" })).toThrow(/revision/i);
    repository.put({ ...original, verifiedState: "Verified", revision: 4, updatedAt: 300 });
    expect(repository.get(original.id)).toMatchObject({ verifiedState: "Verified", revision: 4 });
    db.close();
  });

  it("persists current, history, and ambiguity candidates across repository reconstruction", () => {
    const db = new Database(":memory:");
    const first = new TalkTopicRepository(db);
    first.saveNavigation({
      talkSessionId: "talk-normal-chat",
      currentTopicId: "topic-release",
      history: ["topic-first", "topic-release"],
      lastCandidateIds: ["topic-a", "topic-b"],
      credentialGeneration: 3,
      screenRevision: 17,
      updatedAt: 400,
    });

    expect(new TalkTopicRepository(db).navigation("talk-normal-chat")).toEqual({
      talkSessionId: "talk-normal-chat",
      currentTopicId: "topic-release",
      history: ["topic-first", "topic-release"],
      lastCandidateIds: ["topic-a", "topic-b"],
      credentialGeneration: 3,
      screenRevision: 17,
      updatedAt: 400,
    });
    db.close();
  });
});
