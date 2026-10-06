import { describe, expect, it } from "vitest";
import { resolveAutoCompactPolicy } from "../../shared/auto-compact-config.js";
import { redactText } from "../../shared/redact.js";
import type { JinnConfig } from "../../shared/types.js";
import type { AutoCompactGo } from "../auto-compaction.js";
import { autoCompactLogLine } from "../turn/auto-compact.js";

/**
 * The `[auto-compact]` line exists to be read back against the spend ledger,
 * so it must survive the logger's secret scrubber, which blanks any
 * `…token…=` value whatever its case — and, given an empty value, the field
 * after it too.
 */

const policy = resolveAutoCompactPolicy({ engines: { opencode: { autoCompact: { enabled: true } } } } as unknown as JinnConfig, "opencode")!;

const budget: AutoCompactGo = { compact: true, trigger: "budget", contextTokens: 320_000, budgetTokens: 300_000, policy };
const cold: AutoCompactGo = { compact: true, trigger: "cold", contextTokens: 180_000, idleMs: 2_520_000, policy };

describe("the [auto-compact] log line", () => {
  it("keeps every size and the cost through the logger's redaction, with no post-compaction size (opencode)", () => {
    const line = autoCompactLogLine(
      { sessionId: "s1", engine: "opencode", outcome: "compacted", decision: budget, durationMs: 41_230 },
      { compaction: { preTokens: 320_000 }, cost: 0.02 },
    );
    expect(line).toBe("[auto-compact] session=s1 engine=opencode outcome=compacted trigger=budget budget=300000 "
      + "context=320000 pre=320000 post=- costUsd=0.0200 durationMs=41230");
    expect(redactText(line)).toBe(line);
  });

  it("keeps every size and the cost through the logger's redaction on a cold compaction with full stats", () => {
    const line = autoCompactLogLine(
      { sessionId: "s2", engine: "claude", outcome: "compacted", decision: cold, durationMs: 23_015 },
      { compaction: { preTokens: 180_000, postTokens: 9_000 }, cost: 0.421 },
    );
    expect(line).toBe("[auto-compact] session=s2 engine=claude outcome=compacted trigger=cold idleSec=2520 windowSec=300 "
      + "context=180000 pre=180000 post=9000 costUsd=0.4210 durationMs=23015");
    expect(redactText(line)).toBe(line);
  });

  it("writes '-' for a result it never got, so no field is left empty", () => {
    const line = autoCompactLogLine({ sessionId: "s3", engine: "opencode", outcome: "failed", decision: budget, durationMs: 5 });
    expect(line).toContain("pre=- post=- costUsd=- durationMs=5");
    expect(redactText(line)).toBe(line);
  });
});
