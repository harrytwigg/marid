import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorFindings } from "../doctor.js";

/** `doctor` says when a config.yaml fallback chain repeats a target, which still loads but cannot be saved. */

let home: string;

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-fallback-")); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const write = (fallback: unknown[]) => fs.writeFileSync(path.join(home, "config.yaml"), yaml.dump({ engines: { claude: { bin: "claude", model: "opus", fallback } } }));
const run = () => doctorFindings({ home, env: {}, instances: [] });

describe("doctor: fallback chains", () => {
  it("names a repeated target, in either form, and says it still loads", () => {
    for (const chain of [["codex", "codex"], [{ engine: "codex", model: "m" }, { engine: "codex", model: "m" }]]) {
      write(chain);
      const line = run().find((finding) => finding.message.includes("duplicates"));
      expect(line?.level).toBe("problem");
      expect(line?.message).toContain("engines.claude.fallback[1] duplicates engines.claude.fallback[0]");
      expect(line?.message).toContain("It loads (the repeat is ignored)");
    }
  });

  it("is quiet about a clean chain, a missing config and an unreadable one", () => {
    write(["codex", "grok"]);
    expect(run().some((finding) => finding.message === "No fallback chain in config.yaml repeats a target.")).toBe(true);
    fs.rmSync(path.join(home, "config.yaml"));
    expect(run().some((finding) => finding.message.includes("fallback chain"))).toBe(false);
    fs.writeFileSync(path.join(home, "config.yaml"), "engines: [unclosed");
    expect(run().some((finding) => finding.level === "problem")).toBe(false);
  });
});
