import { describe, expect, it } from "vitest";
import { readsAsInterimWait } from "../stop-nudge.js";

describe("readsAsInterimWait", () => {
  it.each([
    "Build started; waiting on it.",
    "Test run is still running in the background.",
    "Two shards running; still waiting.",
    "Monitoring the deploy. I will continue once it finishes.",
  ])("treats %j as a wait", (text) => {
    expect(readsAsInterimWait(text)).toBe(true);
  });

  it.each([
    ["a terminal claim", "All checks pass; PR is ready. Waiting on nothing."],
    ["a finished report", "Build done and tests passed; waiting for review."],
    ["a question", "Waiting on the build. Should I rerun the lint?"],
    ["a blocker", "Blocked on missing credentials while waiting."],
    ["a request for input", "Waiting on the build; please confirm the target branch."],
    ["a reply with no wait in it", "Here are the findings from the review."],
    ["an empty reply", "   "],
    ["a long report", `Waiting on the build. ${"Finding: x. ".repeat(80)}`],
  ])("does not treat %s as a wait", (_label, text) => {
    expect(readsAsInterimWait(text)).toBe(false);
  });
});
