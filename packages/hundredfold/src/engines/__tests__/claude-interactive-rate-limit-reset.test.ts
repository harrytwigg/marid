import { describe, it, expect, beforeEach, vi } from "vitest";

// claude-interactive.ts loads node-pty natively at import time, which fails on
// CI runners. The mapper under test is pure JS with zero PTY dependency.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

const claudeResetsAtSeconds = vi.fn<() => Promise<number | undefined>>();
vi.mock("../../shared/engine-reset-times.js", () => ({
  claudeResetsAtSeconds: () => claudeResetsAtSeconds(),
}));

import { rateLimitFromStopFailure } from "../claude-interactive.js";

const RESETS_AT = Math.floor(Date.parse("2026-08-19T17:00:00.000Z") / 1000);

beforeEach(() => {
  claudeResetsAtSeconds.mockReset();
  claudeResetsAtSeconds.mockResolvedValue(RESETS_AT);
});

describe("rateLimitFromStopFailure", () => {
  it("carries the reset the usage source stated", async () => {
    const rl = await rateLimitFromStopFailure({ hook_event_name: "StopFailure", error: "rate_limit" });
    expect(rl).toEqual({ status: "rejected", rateLimitType: "interactive_detected", resetsAt: RESETS_AT });
  });

  it("omits the reset when no source has one", async () => {
    claudeResetsAtSeconds.mockResolvedValue(undefined);
    const rl = await rateLimitFromStopFailure({ hook_event_name: "StopFailure", error: "rate_limit" });
    expect(rl).toEqual({ status: "rejected", rateLimitType: "interactive_detected" });
    expect(rl?.resetsAt).toBeUndefined();
  });

  it("does not ask the usage source about a failure that is not a rate limit", async () => {
    // The lookup can reach the keychain and the network, so a server_error turn
    // must not pay for it on its way to settling.
    expect(await rateLimitFromStopFailure({ hook_event_name: "StopFailure", error: "server_error" })).toBeNull();
    expect(await rateLimitFromStopFailure({ hook_event_name: "Stop", error: "rate_limit" })).toBeNull();
    expect(await rateLimitFromStopFailure(undefined)).toBeNull();
    expect(claudeResetsAtSeconds).not.toHaveBeenCalled();
  });
});
