import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A build whose one codename constant says "acme": every name derived from it follows.
vi.mock("../../shared/codename-constant.js", () => ({ CODENAME: "acme" }));

import { claudeProjectSlug } from "../../shared/claude-project-slug.js";
import { moveTranscripts } from "../../shared/claude-transcript-move.js";
import { renameStageRoot, stageRootFor } from "../stage-rename.js";
import { backupRootFor, legacyBackupRootFor, renameBackupDirs } from "../backup-rename.js";
import { doctorFindings } from "../../cli/doctor.js";
import { tryAcquireHomeLock } from "../home-lock.js";

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stage-rename-"))); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

const touch = (file: string, content = "x"): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

describe("stage roots", () => {
  it("are keyed by the container and the instance, under either codename", () => {
    expect(stageRootFor("/h/.jinn-john", { codename: "acme", upper: "ACME", title: "Acme", renamed: true }, true)).toBe("/h/.jinn-departments/.instances/.jinn-john");
    expect(stageRootFor("/h/.acme-john", { codename: "acme", upper: "ACME", title: "Acme", renamed: true }, false)).toBe("/h/.acme-departments/.instances/.acme-john");
    expect(stageRootFor("/h/.jinn-john", { codename: "acme", upper: "ACME", title: "Acme", renamed: true }, false)).toBe("/h/.acme-departments/.instances/.acme-john");
  });

  it("moves one instance's root and leaves another instance's beside it in the old container", () => {
    const config = path.join(root, "claude");
    touch(path.join(root, ".jinn-departments", ".instances", ".jinn-john", "ops", "CLAUDE.md"));
    touch(path.join(root, ".jinn-departments", ".instances", ".jinn-other", "ops", "CLAUDE.md"));
    const oldStage = path.join(root, ".jinn-departments", ".instances", ".jinn-john", "ops");
    touch(path.join(config, "projects", claudeProjectSlug(oldStage), "a.jsonl"));

    const result = renameStageRoot(path.join(root, ".jinn-john"), path.join(root, ".acme-john"), [config]);

    expect(result).toMatchObject({ departments: ["ops"], transcripts: 1 });
    const newStage = path.join(root, ".acme-departments", ".instances", ".acme-john", "ops");
    expect(fs.existsSync(path.join(newStage, "CLAUDE.md"))).toBe(true);
    expect(fs.existsSync(path.join(config, "projects", claudeProjectSlug(newStage), "a.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".jinn-departments", ".instances", ".jinn-other", "ops", "CLAUDE.md"))).toBe(true);
  });

  it("does nothing when there is no old root or the new one exists", () => {
    expect(renameStageRoot(path.join(root, ".jinn-john"), path.join(root, ".acme-john"), [])).toBeUndefined();
    touch(path.join(root, ".jinn-departments", ".instances", ".jinn-john", "ops", "x"));
    touch(path.join(root, ".acme-departments", ".instances", ".acme-john", "ops", "y"));
    expect(renameStageRoot(path.join(root, ".jinn-john"), path.join(root, ".acme-john"), [])).toBeUndefined();
  });
});

describe("moving conversations", () => {
  it("merges into a project directory the new key already has, keeping what is there", () => {
    const config = path.join(root, "claude");
    touch(path.join(config, "projects", claudeProjectSlug("/a/old"), "one.jsonl"), "old one");
    touch(path.join(config, "projects", claudeProjectSlug("/a/old"), "both.jsonl"), "old both");
    touch(path.join(config, "projects", claudeProjectSlug("/a/new"), "both.jsonl"), "new both");
    expect(moveTranscripts("/a/old", "/a/new", [config])).toHaveLength(1);
    const target = path.join(config, "projects", claudeProjectSlug("/a/new"));
    expect(fs.readFileSync(path.join(target, "one.jsonl"), "utf-8")).toBe("old one");
    expect(fs.readFileSync(path.join(target, "both.jsonl"), "utf-8")).toBe("new both");
  });

  it("moves in every profile it is given and reports a failure without stopping", () => {
    const [a, b] = [path.join(root, "a"), path.join(root, "b")];
    touch(path.join(a, "projects", claudeProjectSlug("/x"), "1.jsonl"));
    touch(path.join(b, "projects", claudeProjectSlug("/x"), "2.jsonl"));
    expect(moveTranscripts("/x", "/y", [a, b, a])).toHaveLength(2);
    expect(moveTranscripts("/y", "/y", [a])).toEqual([]);
    const errors: string[] = [];
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("denied"); });
    touch(path.join(a, "projects", claudeProjectSlug("/p"), "3.jsonl"));
    expect(moveTranscripts("/p", "/q", [a], (message) => errors.push(message))).toEqual([]);
    expect(errors[0]).toContain("denied");
  });
});

describe("snapshots", () => {
  it("move to the current root under the current name, merging every place they may be", () => {
    touch(path.join(legacyBackupRootFor(root), "jinn-john", "2026-10-01", "m"));
    touch(path.join(backupRootFor(root), "jinn-john", "2026-10-02", "m"));
    touch(path.join(backupRootFor(root), "acme-john", "2026-10-02", "kept"));
    touch(path.join(legacyBackupRootFor(root), "jinn-other", "2026-09-01", "m"));
    expect(renameBackupDirs({ homeDir: root, legacyName: "jinn-john", currentName: "acme-john" })).toBe(2);
    const target = path.join(backupRootFor(root), "acme-john");
    expect(fs.readdirSync(target).sort()).toEqual(["2026-10-01", "2026-10-02"]);
    expect(fs.readFileSync(path.join(target, "2026-10-02", "kept"), "utf-8")).toBe("x");
    expect(fs.existsSync(path.join(legacyBackupRootFor(root), "jinn-other", "2026-09-01"))).toBe(true);
  });
});

describe("the move lock", () => {
  it("is held by one live process, and taken over once its process is gone", () => {
    const file = path.join(root, "lock");
    const first = tryAcquireHomeLock(file)!;
    expect(tryAcquireHomeLock(file)).toBeUndefined();
    first.release();
    expect(tryAcquireHomeLock(file)).toBeDefined();
    fs.writeFileSync(file, "999999");
    expect(tryAcquireHomeLock(file)).toBeDefined();
  });
});

describe("doctor", () => {
  it("says what is left to do, and stays quiet about what is done", () => {
    vi.spyOn(os, "homedir").mockReturnValue(root);
    fs.mkdirSync(path.join(root, ".jinn-john"));
    const pending = doctorFindings({ home: path.join(root, ".jinn-john"), env: { JINN_PORT: "1", PATH: "/bin" }, instances: [] });
    expect(pending.find((finding) => finding.level === "problem")?.message).toContain("still at");
    expect(pending.some((finding) => finding.message.includes("JINN_PORT"))).toBe(true);
    fs.renameSync(path.join(root, ".jinn-john"), path.join(root, ".acme-john"));
    fs.symlinkSync(path.join(root, ".acme-john"), path.join(root, ".jinn-john"), "dir");
    const done = doctorFindings({ home: path.join(root, ".jinn-john"), env: {}, instances: [] });
    expect(done.some((finding) => finding.level === "problem")).toBe(false);
    expect(done[0].message).toContain("link to it");
  });

  it("reports one instance registered under two names", () => {
    const base = { port: 1, createdAt: "x", id: "i" };
    const findings = doctorFindings({ home: path.join(root, ".acme"), env: {}, instances: [{ ...base, name: "jinn-a", home: "/a" }, { ...base, name: "acme-a", home: "/b" }] });
    expect(findings.filter((finding) => finding.level === "problem").map((finding) => finding.message).join("\n")).toContain("one instance under two names");
  });
});
