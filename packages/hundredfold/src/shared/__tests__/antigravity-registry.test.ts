import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { buildRegistry, refreshAntigravityModels } from "../models.js";
import type { HundredfoldConfig } from "../types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-antigravity-registry-"));

afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** A stand-in `agy` that prints the catalog under test. `\002` is a control
 *  character `.trim()` does not remove, which is what makes the line malformed. */
function fakeAgy(name: string, catalog: string): HundredfoldConfig {
  const bin = path.join(tmp, name);
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '${catalog}'\n`);
  fs.chmodSync(bin, 0o755);
  return {
    engines: { default: "claude", claude: { bin: "claude", model: "opus" }, antigravity: { bin } },
  } as unknown as HundredfoldConfig;
}

// This is the path the live incident took: no model was pinned, so the swap ran on
// `registry.defaultModel` — which was the first discovered line, composite and all.
describe.skipIf(process.platform === "win32")("the antigravity registry, built from real discovery", () => {
  it("drops a malformed discovered id and defaults to the first one that survived", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const config = fakeAgy(
      "agy-malformed-first",
      "gemini-3.7-flash-\\002low\\tGemini 3.7 Flash (Low)\\n" +
        "gemini-3.7-flash-high\\tGemini 3.7 Flash (High)\\n" +
        "gemini-3.7-flash-medium\\tGemini 3.7 Flash (Medium)\\n",
    );

    await refreshAntigravityModels(config);
    const registry = buildRegistry(config);

    expect(registry.antigravity.models.map((model) => model.id))
      .toEqual(["gemini-3.7-flash-high", "gemini-3.7-flash-medium"]);
    expect(registry.antigravity.defaultModel).toBe("gemini-3.7-flash-high");
    expect(warn.mock.calls.some(([message]) => String(message).includes("not a model id"))).toBe(true);
    warn.mockRestore();
  });

  it("keeps the id and the label apart when the catalog is tab-separated", async () => {
    const config = fakeAgy("agy-tsv", "gemini-3.7-flash-high\\tGemini 3.7 Flash (High)\\n");

    await refreshAntigravityModels(config);

    expect(buildRegistry(config).antigravity.models).toEqual([
      { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)", supportsEffort: false, effortLevels: [] },
    ]);
  });
});
