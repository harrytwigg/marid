import { AntigravityEngine } from "./antigravity.js";
import { AntigravityHeadlessEngine } from "./antigravity-headless.js";
import type { PtyLifecycleManager } from "./pty-lifecycle.js";

/** Keep work and terminal adapters paired explicitly so server wiring cannot drift. */
export function createAntigravityEnginePair(lifecycle: PtyLifecycleManager): {
  work: AntigravityHeadlessEngine;
  pty: AntigravityEngine;
} {
  return {
    work: new AntigravityHeadlessEngine(),
    pty: new AntigravityEngine(lifecycle),
  };
}
