import { afterEach, describe, expect, it } from "vitest";
import { beginLimitProbe, endLimitProbe, isProbingLimit } from "../limit-probe.js";
import { effectiveSessionStatus } from "../background-work.js";

afterEach(() => {
  endLimitProbe("s1");
});

describe("a retry against a usage limit that has shown no output", () => {
  it("reports a running session as waiting until the probe ends", () => {
    expect(effectiveSessionStatus({ id: "s1", status: "running" }, undefined)).toBe("running");

    beginLimitProbe("s1");
    expect(isProbingLimit("s1")).toBe(true);
    expect(effectiveSessionStatus({ id: "s1", status: "running" }, undefined)).toBe("waiting");

    expect(endLimitProbe("s1")).toBe(true);
    expect(effectiveSessionStatus({ id: "s1", status: "running" }, undefined)).toBe("running");
  });

  it("tells the caller whether there was a probe to end", () => {
    expect(endLimitProbe("s1")).toBe(false);
    beginLimitProbe("s1");
    expect(endLimitProbe("s1")).toBe(true);
    expect(endLimitProbe("s1")).toBe(false);
  });

  it("changes nothing for a session that is not running, or another session", () => {
    beginLimitProbe("s1");
    expect(effectiveSessionStatus({ id: "s1", status: "error" }, undefined)).toBe("error");
    expect(effectiveSessionStatus({ id: "s1", status: "interrupted" }, undefined)).toBe("interrupted");
    expect(effectiveSessionStatus({ id: "other", status: "running" }, undefined)).toBe("running");
    expect(effectiveSessionStatus({ status: "running" }, undefined)).toBe("running");
  });
});
