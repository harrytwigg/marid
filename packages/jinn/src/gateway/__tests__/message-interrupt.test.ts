import { describe, expect, it } from "vitest";
import { shouldInterruptRunningTurn } from "../message-interrupt.js";

describe("shouldInterruptRunningTurn", () => {
  const base = { isNotification: false, prompt: "stop, do this instead", interruptOnNewMessage: undefined, turnRunning: true };

  it("lets an operator message cut a running turn off, unless configured not to", () => {
    expect(shouldInterruptRunningTurn(base)).toBe(true);
    expect(shouldInterruptRunningTurn({ ...base, interruptOnNewMessage: false })).toBe(false);
  });

  it("never interrupts for a notification, or when nothing is running", () => {
    expect(shouldInterruptRunningTurn({ ...base, isNotification: true })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, turnRunning: false })).toBe(false);
  });

  it("queues /compact behind the running turn instead", () => {
    expect(shouldInterruptRunningTurn({ ...base, prompt: "/compact" })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, prompt: "  /compact keep the ids" })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, prompt: "/compaction is next" })).toBe(true);
  });
});
