import { describe, expect, it } from "vitest";
import { quietWindows } from "../todo-quiet-watch.js";

describe("gateway.todoQuietWatch", () => {
  it("defaults to on, 15 minutes, 60 while a background shell task is counted", () => {
    expect(quietWindows(undefined)).toEqual({ afterMs: 15 * 60_000, backgroundTaskMs: 60 * 60_000 });
    expect(quietWindows({})).toEqual({ afterMs: 15 * 60_000, backgroundTaskMs: 60 * 60_000 });
  });

  it("takes minutes, ignores nonsense, and turns off only when told", () => {
    expect(quietWindows({ afterMinutes: 5, backgroundTaskMinutes: 90 })).toEqual({ afterMs: 5 * 60_000, backgroundTaskMs: 90 * 60_000 });
    expect(quietWindows({ afterMinutes: 0, backgroundTaskMinutes: -3 })).toEqual({ afterMs: 15 * 60_000, backgroundTaskMs: 60 * 60_000 });
    expect(quietWindows({ enabled: false })).toBeNull();
    expect(quietWindows({ enabled: true, afterMinutes: 2 })).toEqual({ afterMs: 2 * 60_000, backgroundTaskMs: 60 * 60_000 });
  });
});
