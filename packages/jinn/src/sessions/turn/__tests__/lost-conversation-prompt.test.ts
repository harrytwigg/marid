import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../../shared/types.js";

/**
 * A turn whose engine no longer has the conversation it resumed is run again in
 * a fresh one, which knows nothing of the session. Its prompt carries the
 * session's recent messages, anything an interrupt kept from the lost
 * conversation, and the current message, once each.
 */

const messages = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("../../registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../registry.js")>()),
  getMessages: vi.fn(() => messages.rows),
}));

import { resolveLostConversationPrompt } from "../preflight.js";
import { UNSEEN_INTERRUPTED_PROMPTS_META_KEY } from "../superseded.js";

const at = (n: number) => Date.parse("2026-10-01T09:00:00Z") + n * 1000;
const session = (transportMeta: Record<string, unknown> = {}) => ({ id: "s1", engine: "claude", transportMeta }) as unknown as Session;

describe("resolveLostConversationPrompt", () => {
  it("carries the conversation so far, without tool rows, partial blocks or the current message twice", () => {
    messages.rows = [
      { role: "user", content: "fix the parser", timestamp: at(1) },
      { role: "assistant", content: "Used Bash", toolCall: "Bash", timestamp: at(2) },
      { role: "assistant", content: "Fixed; tests pass.", timestamp: at(3) },
      { role: "notification", content: "reviewer replied", timestamp: at(4) },
      { role: "assistant", content: "half a thought", partial: true, timestamp: at(5) },
      { role: "user", content: "now open the PR", timestamp: at(6) },
    ];
    const { promptToRun, carriedInterruptedPrompts } = resolveLostConversationPrompt(session(), "now open the PR");

    expect(promptToRun).toBe([
      "The conversation this Jinn session was running could not be resumed, so this is a new one. "
        + "Sync your context with this transcript of the session (most recent last), then respond to the current message.",
      "USER: fix the parser",
      "ASSISTANT: Fixed; tests pass.",
      "CURRENT MESSAGE:\nnow open the PR",
    ].join("\n\n"));
    expect(carriedInterruptedPrompts).toBe(false);
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
