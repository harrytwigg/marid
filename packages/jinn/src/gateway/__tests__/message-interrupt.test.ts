import { describe, expect, it } from "vitest";
import { resolveMessageDelivery, shouldInterruptRunningTurn } from "../message-interrupt.js";

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

  it("lets a running auto-compaction finish instead of throwing it away", () => {
    expect(shouldInterruptRunningTurn({ ...base, autoCompacting: true })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, autoCompacting: false })).toBe(true);
  });

  it("honours a per-message queue choice over the interrupting default", () => {
    expect(shouldInterruptRunningTurn({ ...base, delivery: "queue" })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, delivery: "queue", interruptOnNewMessage: true })).toBe(false);
  });

  it("honours a per-message send-now choice over a queueing default", () => {
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", interruptOnNewMessage: false })).toBe(true);
  });

  it("keeps the guards above an explicit send-now choice", () => {
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", isNotification: true })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", turnRunning: false })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", autoCompacting: true })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", prompt: "/compact" })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", queuePaused: () => true })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, queuePaused: () => true })).toBe(false);
    expect(shouldInterruptRunningTurn({ ...base, delivery: "now", queuePaused: () => false })).toBe(true);
  });
});

describe("resolveMessageDelivery", () => {
  it("prefers an explicit delivery, then the legacy interrupt boolean", () => {
    expect(resolveMessageDelivery({ delivery: "queue", interrupt: true })).toBe("queue");
    expect(resolveMessageDelivery({ delivery: "now", interrupt: false })).toBe("now");
    expect(resolveMessageDelivery({ interrupt: true })).toBe("now");
    expect(resolveMessageDelivery({ interrupt: false })).toBe("queue");
  });

  it("leaves anything else to the caller's default", () => {
    expect(resolveMessageDelivery({})).toBeUndefined();
    expect(resolveMessageDelivery({ delivery: "later" })).toBeUndefined();
    expect(resolveMessageDelivery({ delivery: 1, interrupt: "yes" })).toBeUndefined();
  });
});
