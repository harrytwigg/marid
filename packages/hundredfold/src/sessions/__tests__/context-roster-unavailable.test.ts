import { describe, it, expect } from "vitest";
import { buildContext } from "../context.js";
import type { Employee } from "../../shared/types.js";

const baseOpts = {
  source: "slack",
  channel: "C123",
  user: "Alex",
};

const lead: Employee = {
  name: "platform-lead",
  displayName: "Platform Lead",
  department: "platform",
  rank: "manager",
  engine: "codex",
  model: "test-model",
  persona: "You are the platform delivery lead.",
};

/** The roster section of a built context, heading included. */
function workingRoster(context: string): string {
  const marker = "## Working roster (scoped orientation; not exhaustive)";
  const start = context.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = context.indexOf("\n## ", start + marker.length);
  return context.slice(start, end < 0 ? undefined : end);
}

describe("buildContext — an unreadable roster", () => {
  it("says so under the heading instead of omitting the section", () => {
    const out = buildContext({
      ...baseOpts,
      employee: lead,
      rosterUnavailable: "org dir unreadable",
      hundredfoldMcpAttached: true,
    });
    const roster = workingRoster(out);

    expect(roster).toContain("⚠️");
    expect(roster).toContain("org dir unreadable");
    expect(roster).toContain("the company is not empty");
    expect(roster).toContain("list_employees");
  });

  it("omits nothing else: a healthy roster still renders normally", () => {
    const out = buildContext({ ...baseOpts, employee: lead, hundredfoldMcpAttached: true });
    expect(out).not.toContain("could not be read");
  });
});
