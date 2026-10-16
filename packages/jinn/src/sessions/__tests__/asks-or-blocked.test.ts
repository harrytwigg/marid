import { describe, expect, it } from "vitest";
import { asksOrReportsBlocker } from "../stop-nudge.js";

describe("asksOrReportsBlocker", () => {
  it.each([
    "Waiting on the build. Should I also rerun the lint?",
    "Blocked on missing credentials while waiting.",
    "Waiting on the build; please confirm the target branch.",
    "Tests running. Let me know if the scope should change.",
    "I need your approval before deploying; the build is still running.",
  ])("lets %j through", (text) => {
    expect(asksOrReportsBlocker(text)).toBe(true);
  });

  it.each([
    "Build is still running in the background. I'll report once it's done.",
    "Waiting for the reviewer's verdict.",
    "Pass. Suite 812/0, tsc clean. Dev server still running in the background on 4100.",
    "PR opened; waiting on CI.",
  ])("leaves %j to the structural gate", (text) => {
    expect(asksOrReportsBlocker(text)).toBe(false);
  });
});
