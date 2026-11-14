import { describe, expect, it } from "vitest";
import { AntigravityEngine } from "../antigravity.js";
import { AntigravityHeadlessEngine } from "../antigravity-headless.js";
import { createAntigravityEnginePair } from "../antigravity-runtime.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

describe("createAntigravityEnginePair", () => {
  it("routes work turns to headless mode while retaining PTY mode for terminal views", () => {
    const pair = createAntigravityEnginePair(new PtyLifecycleManager({ maxLivePtys: 1 }));

    expect(pair.work).toBeInstanceOf(AntigravityHeadlessEngine);
    expect(pair.pty).toBeInstanceOf(AntigravityEngine);
  });
});
