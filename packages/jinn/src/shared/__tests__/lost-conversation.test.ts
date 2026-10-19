import { describe, expect, it } from "vitest";
import { isLostConversationError, isLostConversationFailure, lostConversationFailure, processStartFailure } from "../process-start.js";

const ID = "01a13f8f-4840-7f30-92cd-aa7c6655b28c";

describe("lostConversationFailure", () => {
  it("is read back as the loss of exactly the conversation it names", () => {
    const error = lostConversationFailure("musecode", ID);
    expect(error).toBe(`musecode has no conversation ${ID} to resume`);
    expect(isLostConversationFailure(error, ID)).toBe(true);
    expect(isLostConversationFailure(error, "another-id")).toBe(false);
    expect(isLostConversationFailure(error, undefined)).toBe(false);
  });

  it("is not matched by words a model or a tool printed", () => {
    expect(isLostConversationFailure(`the user said musecode has no conversation ${ID} to resume`, ID)).toBe(false);
    expect(isLostConversationFailure(`musecode has no conversation ${ID} to resume, so I am starting over`, ID)).toBe(false);
    expect(isLostConversationFailure("", ID)).toBe(false);
  });
});

describe("isLostConversationError", () => {
  it("accepts both ways an engine reports a lost conversation", () => {
    expect(isLostConversationError(lostConversationFailure("musecode", ID), ID)).toBe(true);
    expect(isLostConversationError(processStartFailure("claude", { exitCode: 1, signal: 0 }, `No conversation found with session ID: ${ID}`), ID)).toBe(true);
  });

  it("accepts neither a process that merely failed to start nor an unrelated error", () => {
    expect(isLostConversationError(processStartFailure("claude", { exitCode: 255, signal: 0 }, "ssh: connect to host: Connection refused"), ID)).toBe(false);
    expect(isLostConversationError("API error 429", ID)).toBe(false);
    expect(isLostConversationError(`No conversation found with session ID: ${ID}`, ID)).toBe(false);
  });
});
