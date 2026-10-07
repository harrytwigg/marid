import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { findNewJsonl, listJsonlNames } from "../fork.js";

/**
 * The interactive fork must find the transcript the spawned process writes even
 * when the filesystem clock trails Date.now(), so detection is by directory
 * listing rather than by file timestamps.
 */
describe("findNewJsonl", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-jsonl-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("finds a new transcript whose timestamps are older than the spawn", async () => {
    fs.writeFileSync(path.join(dir, "old.jsonl"), "{}\n");
    const known = listJsonlNames(dir);
    const file = path.join(dir, "forked.jsonl");
    fs.writeFileSync(file, "{}\n");
    const past = new Date(Date.now() - 5_000);
    fs.utimesSync(file, past, past);
    await expect(findNewJsonl(dir, known, 1_000)).resolves.toBe("forked");
  });

  it("ignores transcripts that existed before the spawn, even if they are rewritten", async () => {
    fs.writeFileSync(path.join(dir, "old.jsonl"), "{}\n");
    const known = listJsonlNames(dir);
    fs.appendFileSync(path.join(dir, "old.jsonl"), "{}\n");
    await expect(findNewJsonl(dir, known, 300)).resolves.toBeNull();
  });

  it("skips empty files and non-jsonl files, then returns once content appears", async () => {
    const known = listJsonlNames(dir);
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    fs.writeFileSync(path.join(dir, "forked.jsonl"), "");
    setTimeout(() => fs.writeFileSync(path.join(dir, "forked.jsonl"), "{}\n"), 100);
    await expect(findNewJsonl(dir, known, 2_000)).resolves.toBe("forked");
  });

  it("finds a transcript in a directory that did not exist before the spawn", async () => {
    const projectDir = path.join(dir, "projects", "-work");
    const known = listJsonlNames(projectDir);
    setTimeout(() => {
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "forked.jsonl"), "{}\n");
    }, 100);
    await expect(findNewJsonl(projectDir, known, 2_000)).resolves.toBe("forked");
  });
});
