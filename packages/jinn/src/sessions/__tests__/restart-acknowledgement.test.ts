import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-restart-ack-"));
process.env.JINN_HOME = tmp;

type Registry = typeof import("../registry.js");
let registry: Registry;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  registry = await import("../registry.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM sessions").run();
});

const BOOT = Date.parse("2026-07-11T08:05:00.000Z");
const ASKED = "2026-07-11T08:00:00.000Z";
const minutesBefore = (iso: string, minutes: number) => new Date(Date.parse(iso) - minutes * 60_000).toISOString();

function requester(meta: Record<string, unknown> = {}) {
  const session = registry.createSession({ engine: "claude", source: "web", sourceRef: `web:restart-notice:${Math.random()}` });
  registry.updateSession(session.id, { transportMeta: { keep: "value", [registry.RESTART_ACK_META_KEY]: ASKED, ...meta } });
  return session;
}

describe("consumeRestartAcknowledgements", () => {
  it("persists a visible notification, stamps the requester for its resume nudge, and consumes the marker once", () => {
    const session = requester();

    expect(registry.consumeRestartAcknowledgements(BOOT)).toEqual([
      { sessionId: session.id, acknowledgedAt: ASKED, resume: "nudge" },
    ]);
    expect(registry.getMessages(session.id).at(-1)).toMatchObject({
      role: "notification",
      content: "Gateway restarted successfully.",
    });
    expect(registry.getSession(session.id)?.transportMeta).toEqual({
      keep: "value",
      [registry.RESTART_RESUME_META_KEY]: ASKED,
      [registry.RESTART_RESUME_REASON_META_KEY]: "requested",
    });

    expect(registry.consumeRestartAcknowledgements(BOOT)).toEqual([]);
    expect(registry.getMessages(session.id).filter((message) => message.content === "Gateway restarted successfully.")).toHaveLength(1);
  });

  it("still nudges a session that asks again soon after one nudge: deploy, verify fails, fix, redeploy", () => {
    const session = requester({ [registry.RESTART_REQUESTER_NUDGES_META_KEY]: [minutesBefore(ASKED, 5)] });

    expect(registry.consumeRestartAcknowledgements(BOOT)[0]).toMatchObject({ sessionId: session.id, resume: "nudge" });
  });

  it("holds back the nudge for a session already nudged back twice within the window (restart-loop guard)", () => {
    const session = requester({ [registry.RESTART_REQUESTER_NUDGES_META_KEY]: [minutesBefore(ASKED, 20), minutesBefore(ASKED, 5)] });

    expect(registry.consumeRestartAcknowledgements(BOOT)).toEqual([
      { sessionId: session.id, acknowledgedAt: ASKED, resume: "loop-guard" },
    ]);
    const meta = registry.getSession(session.id)?.transportMeta ?? {};
    expect(meta).not.toHaveProperty(registry.RESTART_RESUME_META_KEY);
    expect(meta).not.toHaveProperty(registry.RESTART_ACK_META_KEY);
    // The notice is still posted: the guard withholds the nudge, not the information.
    expect(registry.getMessages(session.id)).toHaveLength(1);
  });

  it("forgets nudges that have aged out of the window", () => {
    const session = requester({ [registry.RESTART_REQUESTER_NUDGES_META_KEY]: [minutesBefore(ASKED, 45), minutesBefore(ASKED, 31)] });

    expect(registry.consumeRestartAcknowledgements(BOOT)[0]).toMatchObject({ sessionId: session.id, resume: "nudge" });
  });

  it("gives a request older than the restart that just happened the notice only", () => {
    const session = requester();

    expect(registry.consumeRestartAcknowledgements(BOOT + 31 * 60_000)[0]).toMatchObject({ sessionId: session.id, resume: "stale" });
    expect(registry.getSession(session.id)?.transportMeta).toEqual({ keep: "value" });
  });
});

describe("stampRestartRequesterNudged", () => {
  it("appends the nudge and drops the ones outside the loop-guard window", () => {
    const session = requester({ [registry.RESTART_REQUESTER_NUDGES_META_KEY]: [minutesBefore(ASKED, 40), minutesBefore(ASKED, 10)] });

    registry.stampRestartRequesterNudged(session.id, ASKED);

    expect(registry.getSession(session.id)?.transportMeta?.[registry.RESTART_REQUESTER_NUDGES_META_KEY]).toEqual([minutesBefore(ASKED, 10), ASKED]);
  });
});
