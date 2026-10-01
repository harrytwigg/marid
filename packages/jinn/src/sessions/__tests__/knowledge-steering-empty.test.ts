import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// An instance with no knowledge files has no knowledge section, so guidance
// must still reach the prompt rather than vanish with it.
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-steering-empty-"));

function build(knowledge?: Record<string, unknown>, jinnMcpAttached = true): Promise<string> {
  return import("../context.js").then(({ buildContext }) =>
    buildContext({
      source: "web",
      channel: "web:test",
      user: "operator",
      sessionId: "knowledge-steering-empty-session",
      config: { gateway: { port: 7777 }, engines: { default: "codex" }, ...(knowledge ? { knowledge } : {}) } as any,
      jinnMcpAttached,
    }),
  );
}

describe("knowledge.guidance with no knowledge files", () => {
  it("is shown under its own heading", async () => {
    expect(await build({ guidance: "Use the state files." })).toContain("## Knowledge base\nUse the state files.");
    expect(await build({ guidance: "Use the state files." }, false)).toContain("## Knowledge base\nUse the state files.");
  });

  it("unset still produces no knowledge section", async () => {
    expect(await build()).not.toContain("## Knowledge base");
    expect(await build({ guidance: " " })).not.toContain("## Knowledge base");
  });
});
