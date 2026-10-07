import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../shared/types.js";

/**
 * A turn whose engine no longer has the conversation it resumed is run in a
 * fresh one, which knows nothing of the session. Its prompt carries the
 * session's recent messages (including what other sessions sent it), anything
 * an interrupt kept from the lost conversation, and the current message, once
 * each, and never a message queued behind this turn. It has to fit in one
 * command-line argument alongside a remote session's system prompt.
 */

const messages = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  open: { prompts: [] as string[], messageIds: new Set<string>() },
}));
vi.mock("../../registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../registry.js")>()),
  getMessages: vi.fn(() => messages.rows),
}));
vi.mock("../../queue-item-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../queue-item-registry.js")>()),
  openTurnMessages: vi.fn(() => messages.open),
}));

import { LOST_CONVERSATION_META_KEY, resolveLostConversationPrompt, resolveTurnPrompt, withSyncMarkersCleared } from "../preflight.js";
import { UNSEEN_INTERRUPTED_PROMPTS_META_KEY } from "../superseded.js";

const INTRO = "The conversation this Jinn session was running could not be resumed, so this is a new one. "
  + "Sync your context with this transcript of the session (most recent last), then respond to the current message.";
const at = (n: number) => Date.parse("2026-10-01T09:00:00Z") + n * 1000;
const session = (transportMeta: Record<string, unknown> = {}) => ({ id: "s1", engine: "claude", transportMeta }) as unknown as Session;

/** A message from another session, framed for the engine as a lateral send frames it. */
const framed = (raw: string) => `📨 Message from session abc (qa) [hop 1/12]:\n\n${raw}\n\nTo reply: send_to_session { sessionId: "abc" }.`;

describe("resolveLostConversationPrompt", () => {
  beforeEach(() => {
    messages.open = { prompts: [], messageIds: new Set() };
  });

  it("carries the conversation so far, with other sessions' messages in full, and no tool rows or partial blocks", () => {
    messages.rows = [
      { role: "user", content: "fix the parser", timestamp: at(1) },
      { role: "assistant", content: "Used Bash", toolCall: "Bash", timestamp: at(2) },
      { role: "assistant", content: "Asked QA.", timestamp: at(3) },
      { role: "notification", content: "QA replied", meta: { fullMessage: "Changes required: parser.ts:12 drops the last token." }, timestamp: at(4) },
      { role: "notification", content: "a reminder with no full text", timestamp: at(5) },
      { role: "assistant", content: "half a thought", partial: true, timestamp: at(6) },
      { role: "assistant", content: "Fixed parser.ts:12 as QA asked.", timestamp: at(7) },
      { role: "user", content: "now open the PR", timestamp: at(8) },
    ];
    const { promptToRun, carriedInterruptedPrompts } = resolveLostConversationPrompt(session(), "now open the PR");

    expect(promptToRun).toBe([
      INTRO,
      "USER: fix the parser",
      "ASSISTANT: Asked QA.",
      "MESSAGE FROM ANOTHER SESSION: Changes required: parser.ts:12 drops the last token.",
      "MESSAGE FROM ANOTHER SESSION: a reminder with no full text",
      "ASSISTANT: Fixed parser.ts:12 as QA asked.",
      "CURRENT MESSAGE:\nnow open the PR",
    ].join("\n\n"));
    expect(carriedInterruptedPrompts).toBe(false);
  });

  it("leaves out this turn's own message from another session, and anything queued behind it", () => {
    const verdict = "QA verdict: pass, merge it.";
    messages.rows = [
      { id: "m1", role: "user", content: "fix the parser", timestamp: at(1) },
      { id: "m2", role: "assistant", content: "Asked QA.", timestamp: at(2) },
      { id: "m3", role: "notification", content: `📨 From qa: ${verdict}`, meta: { fullMessage: verdict }, timestamp: at(3) },
      { id: "m4", role: "user", content: "queued: also bump the version", timestamp: at(4) },
      { id: "m5", role: "notification", content: "📩 dev replied\nshort banner", timestamp: at(5) },
    ];
    // m4 is a queued web message (its queue row links it); m5 is a callback batched into a pending item.
    messages.open = { prompts: [framed(verdict), "queued: also bump the version", "📩 framed callback"], messageIds: new Set(["m4", "m5"]) };
    const { promptToRun } = resolveLostConversationPrompt(session(), framed(verdict));

    expect(promptToRun).toBe([INTRO, "USER: fix the parser", "ASSISTANT: Asked QA.", `CURRENT MESSAGE:\n${framed(verdict)}`].join("\n\n"));
  });

  it("keeps an earlier turn's reply that was logged after a message queued during that turn", () => {
    messages.rows = [
      { id: "m1", role: "user", content: "A", timestamp: at(1) },
      { id: "m2", role: "user", content: "B", timestamp: at(2) },
      { id: "m3", role: "user", content: "C", timestamp: at(3) },
      { id: "m4", role: "assistant", content: "answer to A", timestamp: at(4) },
    ];
    messages.open = { prompts: ["B", "C"], messageIds: new Set(["m2", "m3"]) };
    const { promptToRun } = resolveLostConversationPrompt(session(), "B");

    expect(promptToRun).toBe([INTRO, "USER: A", "ASSISTANT: answer to A", "CURRENT MESSAGE:\nB"].join("\n\n"));
  });

  it("stays within its budget however long the history, keeping the newest messages", () => {
    messages.rows = Array.from({ length: 21 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `${i}:${"é".repeat(3_500)}`,
      timestamp: at(i),
    }));
    messages.rows.push({ role: "user", content: "go on", timestamp: at(30) });
    const { promptToRun } = resolveLostConversationPrompt(session(), "go on");

    expect(Buffer.byteLength(promptToRun)).toBeLessThanOrEqual(24_000 + Buffer.byteLength(INTRO) + 100);
    expect(promptToRun).toContain("USER: 20:é");
    expect(promptToRun).toContain("[…clipped]");
    expect(promptToRun).not.toContain("USER: 0:");
    expect(promptToRun).not.toContain("�");
    expect(promptToRun.endsWith("CURRENT MESSAGE:\ngo on")).toBe(true);
  });

  it("asks for an answer to messages an interrupt kept from the lost conversation, not only the current one", () => {
    messages.rows = [
      { role: "user", content: "first", timestamp: at(1) },
      { role: "assistant", content: "done", timestamp: at(2) },
      { role: "user", content: "also check the docs", timestamp: at(3) },
      { role: "user", content: "and the changelog", timestamp: at(4) },
    ];
    const { promptToRun, carriedInterruptedPrompts } = resolveLostConversationPrompt(
      session({ [UNSEEN_INTERRUPTED_PROMPTS_META_KEY]: ["also check the docs"] }),
      "and the changelog",
    );

    expect(carriedInterruptedPrompts).toBe(true);
    expect(promptToRun).toContain("USER: first\n\nASSISTANT: done");
    expect(promptToRun).not.toContain("USER: also check the docs");
    expect(promptToRun).toContain("EARLIER MESSAGE:\nalso check the docs");
    expect(promptToRun.endsWith("CURRENT MESSAGE:\nand the changelog")).toBe(true);
  });

  it("is just the message when the session has nothing before it", () => {
    messages.rows = [{ role: "user", content: "hello", timestamp: at(1) }];
    expect(resolveLostConversationPrompt(session(), "hello")).toEqual({ promptToRun: "hello", carriedInterruptedPrompts: false });
  });
});

describe("a session marked as having lost its conversation", () => {
  const lost = () => session({ [LOST_CONVERSATION_META_KEY]: "claude" });

  it("hands its next fresh turn the transcript, owed until that turn settles cleanly", () => {
    messages.rows = [
      { role: "user", content: "one", timestamp: at(1) },
      { role: "assistant", content: "hello", timestamp: at(2) },
    ];
    const turn = resolveTurnPrompt(lost(), "claude", "two", false);

    expect(turn).toMatchObject({ syncRequested: true, carriedInterruptedPrompts: false });
    expect(turn.promptToRun).toBe([INTRO, "USER: one", "ASSISTANT: hello", "CURRENT MESSAGE:\ntwo"].join("\n\n"));
    expect(withSyncMarkersCleared(lost().transportMeta)).toEqual({});
  });

  it("is not a reason to send a transcript to a conversation that is being resumed, or to another engine", () => {
    expect(resolveTurnPrompt(lost(), "claude", "two", true)).toMatchObject({ promptToRun: "two", syncRequested: false });
    expect(resolveTurnPrompt(lost(), "codex", "two", false)).toMatchObject({ promptToRun: "two", syncRequested: false });
  });
});
