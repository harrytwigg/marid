import { describe, expect, it } from "vitest";
import { opencodeHealthFindings } from "../doctor-opencode-health.js";
import type { EngineHealthReading } from "../../shared/engine-health.js";

const NOW = new Date("2026-11-12T10:00:00.000Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

describe("opencodeHealthFindings", () => {
  it("is silent when nothing is held out", () => {
    expect(opencodeHealthFindings({}, NOW)).toEqual([]);
    expect(opencodeHealthFindings({ codex: { state: "exhausted", until: later(5) } }, NOW)).toEqual([]);
  });

  it("asks for action on a signed-out provider, and says how to clear it", () => {
    const health: EngineHealthReading = { "opencode/opencode-go": { state: "exhausted", failureClass: "auth", credentialFingerprint: "abc123abc123abc123abc123abc123ab" } };
    const [finding] = opencodeHealthFindings(health, NOW);
    expect(finding).toMatchObject({ level: "problem" });
    expect(finding!.message).toContain("opencode provider opencode-go is signed out");
    expect(finding!.message).toContain("hundredfold limits --clear opencode/opencode-go");
    expect(finding!.message).not.toContain("abc123");
  });

  it("notes a model the account cannot use and a spent allowance, with when each is tried again", () => {
    const health: EngineHealthReading = {
      "opencode/opencode-go/kimi-k2": { state: "exhausted", failureClass: "model-access", until: later(60) },
      "opencode/opencode-go": { state: "exhausted", failureClass: "quota", until: later(30) },
    };
    const findings = opencodeHealthFindings(health, NOW);
    expect(findings.map((finding) => finding.level)).toEqual(["info", "info"]);
    expect(findings[0]!.message).toContain(`opencode model opencode-go/kimi-k2 is not enabled`);
    expect(findings[1]!.message).toContain(`no usable allowance`);
    expect(findings[1]!.message).toContain(later(30));
  });

  it("does not report a record that has lapsed or been cleared", () => {
    expect(opencodeHealthFindings({ "opencode/opencode-go": { state: "ok", clearedAt: later(-1) } }, NOW)).toEqual([]);
  });
});
