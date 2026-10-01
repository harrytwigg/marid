import { describe, expect, it } from "vitest";
import { DEFAULT_VERIFY_MODE_BY_SOURCE } from "../store.js";

// The same literal is asserted against the web app's mirror in
// packages/web/src/lib/__tests__/todos.test.ts; keep the two in step.
describe("default verify mode by source", () => {
  it("is the map the web app mirrors", () => {
    expect(DEFAULT_VERIFY_MODE_BY_SOURCE).toEqual({
      cron: "trust",
      workflow: "verify",
      delegation: "verify",
      human: "verify",
      session: "verify",
      connector: "verify",
      goal: "verify",
    });
  });
});
