import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../shared/types.js";

/**
 * After a deliberate switch (`engineSyncMode: "pointer"`) the new conversation is told where to read
 * the history and is never handed it; every other catch-up (`engineSyncTarget` without the mode) pastes
 * the transcript exactly as it always did.
 */

const messages = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("../../registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../registry.js")>()),
  getMessages: vi.fn(() => messages.rows),
}));

import { resolveSyncPrompt, resolveTurnPrompt } from "../preflight.js";
import { historyPointerPrompt, POINTER_READ_LAST, POINTER_READ_MAX } from "../history-pointer.js";

const at = (n: number) => Date.parse("2026-10-01T09:00:00Z") + n * 1000;
const SINCE = "2026-10-01T09:00:00.000Z";
const TRANSCRIPT = "/profiles/work/projects/-home/own-thread.jsonl";

function pointerSession(over: Record<string, unknown> = {}, lastSwitch: Record<string, unknown> = { leftTranscript: TRANSCRIPT }): Session {
  return {
    id: "sess-own-id",
    engine: "claude",
    transportMeta: { engineSyncTarget: "claude", engineSyncSince: SINCE, engineSyncMode: "pointer", lastSwitch },
    ...over,
  } as unknown as Session;
}

beforeEach(() => {
  messages.rows = [
    { id: "m1", role: "user", content: "an earlier question about turnips", timestamp: at(1) },
    { id: "m2", role: "assistant", content: "an earlier answer about turnips", timestamp: at(2) },
  ];
});

describe("the pointer prompt", () => {
  it("names read_session with the session's own id, the left transcript, and the current message", () => {
    const { promptToRun, syncRequested } = resolveSyncPrompt(pointerSession(), "claude", "what next?");

    expect(syncRequested).toBe(true);
    expect(promptToRun).toContain('read_session');
    expect(promptToRun).toContain(`{sessionId: "sess-own-id", last: ${POINTER_READ_LAST}}`);
    expect(promptToRun).toContain(`up to ${POINTER_READ_MAX} for more`);
    expect(promptToRun).toContain(TRANSCRIPT);
    expect(promptToRun).toMatch(/CURRENT MESSAGE:\nwhat next\?$/);
  });

  it("never pastes an earlier message's text", () => {
    const { promptToRun } = resolveSyncPrompt(pointerSession(), "claude", "what next?");

    expect(promptToRun).not.toContain("turnips");
    expect(promptToRun).not.toMatch(/USER:|ASSISTANT:/);
  });

  it("leaves the transcript path out when the switch recorded none", () => {
    const prompt = historyPointerPrompt(pointerSession({}, {}), "go");

    expect(prompt).toContain("read_session");
    expect(prompt).not.toMatch(/transcript at/);
  });

  it("gives a department-scoped session read_session only, never a file path", () => {
    const scoped = pointerSession({ scopeDepartment: "lab" });

    const prompt = historyPointerPrompt(scoped, "go");

    expect(prompt).toContain("read_session");
    expect(prompt).not.toContain(TRANSCRIPT);
    expect(prompt).not.toMatch(/transcript at/);
  });

  it("omits the current-message block for an empty prompt", () => {
    expect(historyPointerPrompt(pointerSession(), "  ")).not.toContain("CURRENT MESSAGE");
  });

  it("applies only to the engine the marker names", () => {
    const { promptToRun, syncRequested } = resolveSyncPrompt(pointerSession(), "codex", "hello");

    expect(syncRequested).toBe(false);
    expect(promptToRun).toBe("hello");
  });

  it("is what a switched session gets even when a lost-conversation marker stood beforehand and the switch cleared it", () => {
    // `switchSessionTarget` drops the lost-conversation key before it sets its own marker, so the pointer branch is reached.
    const switched = pointerSession();

    const plan = resolveTurnPrompt(switched, "claude", "after the switch", false);

    expect(plan.syncRequested).toBe(true);
    expect(plan.promptToRun).toContain("read_session");
    expect(plan.promptToRun).not.toContain("turnips");
  });
});

describe("the pasted catch-up", () => {
  const transcriptSession = (mode?: string) => pointerSession({
    transportMeta: { engineSyncTarget: "claude", engineSyncSince: SINCE, ...(mode ? { engineSyncMode: mode } : {}) },
  });

  const EXPECTED = [
    "We switched engines in this Jinn session. Sync your context with this transcript (most recent last), then respond to the current message.",
    "USER: an earlier question about turnips\n\nASSISTANT: an earlier answer about turnips",
    "CURRENT MESSAGE:\nwhat next?",
  ].join("\n\n");

  it("is unchanged byte for byte when no mode is set", () => {
    expect(resolveSyncPrompt(transcriptSession(), "claude", "what next?").promptToRun).toBe(EXPECTED);
  });

  it("is unchanged for an explicit transcript mode", () => {
    expect(resolveSyncPrompt(transcriptSession("transcript"), "claude", "what next?").promptToRun).toBe(EXPECTED);
  });

  it("is unchanged for the Claude-account catch-up, which a pointer marker never reaches", () => {
    const session = pointerSession({ transportMeta: { claudeSyncSince: SINCE, claudeSyncAccount: true, engineSyncMode: "pointer" } });

    const { promptToRun } = resolveSyncPrompt(session, "claude", "what next?");

    expect(promptToRun).toMatch(/^We temporarily ran this session on another Claude account/);
    expect(promptToRun).toContain("USER: an earlier question about turnips");
  });
});
