import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Employee, JinnConfig } from "../../../shared/types.js";
import { TALK_BRIEF_BUDGET_CHARS, buildStandingBrief } from "../brief.js";

/** Invented names throughout: this file ships to strangers. */
function employee(name: string, department: string, rank: Employee["rank"], reportsTo?: string): Employee {
  return {
    name,
    displayName: name
      .split("-")
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join(" "),
    department,
    rank,
    engine: "codex",
    model: "test-model",
    persona: "",
    ...(reportsTo === undefined ? {} : { reportsTo }),
  };
}

function registryOf(employees: Employee[]): Map<string, Employee> {
  return new Map(employees.map((one) => [one.name, one]));
}

function configOf(portal?: JinnConfig["portal"]): Pick<JinnConfig, "portal"> {
  return { portal };
}

/** Two departments, a manager and two reports — a small real org. */
const SMALL_ORG = [
  employee("atlas-lead", "logistics", "manager"),
  employee("beacon-router", "logistics", "senior", "atlas-lead"),
  employee("cobalt-analyst", "research", "senior"),
];

/** `count` employees spread evenly over `departments`, each department led by a
 *  manager the rest report to. */
function largeOrg(count: number, departments: number): Employee[] {
  const people: Employee[] = [];
  for (let index = 0; index < count; index += 1) {
    const department = `unit-${index % departments}`;
    const lead = `lead-${index % departments}`;
    people.push(
      index < departments
        ? employee(lead, department, "manager")
        : employee(`member-${index}`, department, index % 3 === 0 ? "senior" : "employee", lead),
    );
  }
  return people;
}

/** Phrases the roster ladder is never allowed to spend: the posture, what Jinn
 *  is, the blocks glossary, and this instance's own conventions. */
function expectDoctrineIntact(text: string): void {
  expect(text).toContain("COO-grade");
  expect(text).toContain("gateway");
  expect(text).toContain("Todo");
  expect(text).toContain("in_review");
  expect(text).toMatch(/in_review \([^)]*change[^)]*back to executing/);
}

describe("what the brief tells the orb before anyone speaks", () => {
  it("explains the Todo and names everyone, with no tool call", () => {
    const brief = buildStandingBrief(configOf(), registryOf(SMALL_ORG));

    expect(brief.rosterLevel).toBe("full");
    expect(brief.text).toMatch(/Todo — /);
    expect(brief.text).not.toContain("Workflow");
    for (const one of SMALL_ORG) expect(brief.text).toContain(one.name);
  });

  it("names the company and the Todo prefix its own config derives, not a compiled-in one", () => {
    const acme = buildStandingBrief(configOf({ companyName: "Acme Robotics" }), registryOf(SMALL_ORG));
    const northwind = buildStandingBrief(configOf({ companyName: "Northwind Freight" }), registryOf(SMALL_ORG));

    expect(acme.text).toContain("Acme Robotics");
    expect(acme.text).toContain("ACM-");
    expect(northwind.text).toContain("Northwind Freight");
    expect(northwind.text).toContain("NOR-");
    expect(northwind.text).not.toContain("Acme Robotics");
  });

  it("honours an explicit prefix override instead of deriving one", () => {
    const brief = buildStandingBrief(
      configOf({ companyName: "Acme Robotics", companyPrefix: "ZZT" }),
      registryOf(SMALL_ORG),
    );

    expect(brief.text).toContain("ZZT-");
    expect(brief.text).not.toContain("ACM-");
  });

  it("holds no fixture company in its source: every instance word is read at runtime", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, "..", "brief.ts"), "utf-8");

    for (const fixture of ["Acme Robotics", "Northwind Freight", "atlas-lead", "logistics"]) {
      expect(source).not.toContain(fixture);
    }
  });
});

describe("staying inside the budget as the org grows", () => {
  it("lists every employee for a three-person org", () => {
    const brief = buildStandingBrief(configOf(), registryOf(SMALL_ORG));

    expect(brief.rosterLevel).toBe("full");
    expect(brief.text.length).toBeLessThanOrEqual(TALK_BRIEF_BUDGET_CHARS);
    expect(brief.text).toContain("beacon-router");
    // Full rows carry the reporting line, which is half of "who works here".
    expect(brief.text).toContain("atlas-lead");
  });

  it("summarizes the roster of a sixty-person org rather than dropping the doctrine", () => {
    const brief = buildStandingBrief(configOf(), registryOf(largeOrg(60, 8)));

    expect(brief.text.length).toBeLessThanOrEqual(TALK_BRIEF_BUDGET_CHARS);
    expect(brief.rosterLevel).not.toBe("full");
    expectDoctrineIntact(brief.text);
  });

  it("falls all the way to headcounts for a three-hundred-person org", () => {
    const brief = buildStandingBrief(configOf(), registryOf(largeOrg(300, 30)));

    expect(brief.rosterLevel).toBe("counts");
    expect(brief.text.length).toBeLessThanOrEqual(TALK_BRIEF_BUDGET_CHARS);
    expect(brief.text).toContain("300 employees");
    expectDoctrineIntact(brief.text);
  });

  it("never spends doctrine on roster: the ladder only ever steps down", () => {
    const levels = [3, 60, 300].map(
      (count) => buildStandingBrief(configOf(), registryOf(largeOrg(count, Math.max(2, count / 10)))).rosterLevel,
    );

    expect(levels).toEqual(["full", "summary", "counts"]);
  });
});

describe("an instance with nobody in it", () => {
  it("still briefs the orb, and says so rather than throwing", () => {
    const brief = buildStandingBrief(configOf(), new Map());

    expect(brief.rosterLevel).toBe("empty");
    expect(brief.text.length).toBeLessThanOrEqual(TALK_BRIEF_BUDGET_CHARS);
    expectDoctrineIntact(brief.text);
    expect(brief.text).not.toContain("Who works here");
  });
});
