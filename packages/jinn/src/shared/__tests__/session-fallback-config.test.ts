import { describe, expect, it } from "vitest";
import { validateConfigShape } from "../config.js";
import { isSessionFallbackMode, sessionFallbackConfigProblems, sessionFallbackModeError, storedFallbackMode } from "../session-fallback-config.js";

const engines = { claude: { bin: "claude" } };

describe("sessions.fallbackMode config", () => {
  it.each(["fallback", "fallback-children", "auto-resume"])("accepts %s", (mode) => {
    expect(sessionFallbackConfigProblems({ fallbackMode: mode })).toEqual([]);
    expect(validateConfigShape({ engines, sessions: { fallbackMode: mode } })).toEqual([]);
  });

  it("accepts an absent key, and leaves a non-mapping sessions block to its own checks", () => {
    expect(sessionFallbackConfigProblems(undefined)).toEqual([]);
    expect(sessionFallbackConfigProblems({})).toEqual([]);
    expect(sessionFallbackConfigProblems("nope")).toEqual([]);
  });

  it.each([["wait"], [true], [3], [null], ["Fallback"]])("refuses %j, naming the three modes", (bad) => {
    const problems = validateConfigShape({ engines, sessions: { fallbackMode: bad } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^sessions\.fallbackMode must be one of fallback, fallback-children, auto-resume/);
  });

  it("reads a stored column value as a mode or NULL", () => {
    expect(storedFallbackMode("auto-resume")).toBe("auto-resume");
    expect(storedFallbackMode(null)).toBeNull();
    expect(storedFallbackMode("garbage")).toBeNull();
    expect(isSessionFallbackMode(undefined)).toBe(false);
    expect(sessionFallbackModeError("x")).toContain('(got "x")');
  });
});
