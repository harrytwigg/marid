import { describe, expect, it } from "vitest";
import { buildContext } from "../context.js";
import type { Employee, JinnConfig } from "../../shared/types.js";

const employee: Employee = {
  name: "qa-engineer",
  displayName: "QA Engineer",
  department: "quality",
  rank: "senior",
  engine: "codex",
  model: "gpt-5.5",
  persona: "You review changes.",
};

const config = (maxChars?: number) => ({
  gateway: { host: "127.0.0.1", port: 7799 },
  engines: { default: "codex", claude: {}, codex: {} },
  ...(maxChars ? { context: { maxChars } } : {}),
}) as unknown as JinnConfig;

describe("buildContext — no Workflows guidance", () => {
  const sessions = [
    { label: "employee", extra: { employee }, heading: "## Company Identity" },
    { label: "COO", extra: {}, heading: "## COO Company Anchor" },
  ];

  for (const { label, extra, heading } of sessions) {
    it(`never points a ${label} session at the removed Workflows feature, in full or trimmed form`, () => {
      for (const maxChars of [undefined, 1500, 4000]) {
        const out = buildContext({
          source: "slack",
          channel: "C123",
          user: "Alex",
          ...extra,
          engine: "codex",
          jinnMcpAttached: true,
          config: config(maxChars),
        });
        expect(out).toContain(heading);
        expect(out).not.toMatch(/\bWorkflows?\b/);
        expect(out).not.toMatch(/_workflow/);
      }
    });
  }
});
