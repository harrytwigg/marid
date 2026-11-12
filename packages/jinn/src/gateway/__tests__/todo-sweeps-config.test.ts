import { describe, expect, it, vi } from "vitest";

/** The availability sweep is handed the gateway's config, which names the model an opencode session with none runs on. */

const started: Array<{ config?: () => unknown }> = [];
vi.mock("../../work-items/availability-resume.js", () => ({
  startAvailabilityResumeSweep: (deps: { config?: () => unknown }) => { started.push(deps); return () => {}; },
}));
vi.mock("../todo-recovery.js", () => ({ startTodoRecovery: () => () => {} }));
vi.mock("../todo-redispatch.js", () => ({ redispatchTodo: () => ({ status: "assigned" }) }));

const { startTodoSweeps } = await import("../todo-sweeps.js");

describe("startTodoSweeps", () => {
  it("gives the availability sweep the live config", () => {
    const config = { engines: { default: "claude" } };
    const stop = startTodoSweeps({ getConfig: () => config } as never);
    expect(started[0]?.config?.()).toBe(config);
    stop();
  });
});
