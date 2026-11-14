import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Employee, HundredfoldConfig } from "../../../shared/types.js";

vi.mock("../../../gateway/org-registry.js", () => ({ readOrg: vi.fn() }));

vi.mock("../../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { readOrg } from "../../../gateway/org-registry.js";
import { resolveTurnHierarchy } from "../preflight.js";

const config = { engines: { default: "claude" } } as unknown as HundredfoldConfig;

const lead: Employee = {
  name: "platform-lead",
  displayName: "Platform Lead",
  department: "platform",
  rank: "manager",
  engine: "claude",
  model: "opus",
  persona: "You run the platform.",
};

describe("resolveTurnHierarchy", () => {
  beforeEach(() => {
    vi.mocked(readOrg).mockReset();
  });

  it("reports why the roster is missing instead of returning nothing", async () => {
    vi.mocked(readOrg).mockReturnValue({ registry: new Map(), error: "org dir unreadable" });

    const result = await resolveTurnHierarchy(config);

    expect(result.unavailable).toBe("org dir unreadable");
    expect(result.hierarchy).toBeUndefined();
  });

  it("returns the hierarchy and no failure when the scan succeeds", async () => {
    vi.mocked(readOrg).mockReturnValue({ registry: new Map([["platform-lead", lead]]) });

    const result = await resolveTurnHierarchy(config);

    expect(result.unavailable).toBeUndefined();
    expect(result.hierarchy?.nodes["platform-lead"]?.employee).toBe(lead);
  });
});
