import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../shared/logger.js";
import { generateStageFileSet, type StageFileSet } from "../department-stage/file-set.js";
import { syncStageDir } from "../department-stage/sync.js";

/** FR-020a: the stage directory is synced in place, file by file, and never replaced. */

let root: string;
let stage: string;
const files = (entries: Record<string, string | { text: string; executable: boolean }>): StageFileSet =>
  new Map(Object.entries(entries).map(([rel, v]) => [rel, { content: Buffer.from(typeof v === "string" ? v : v.text), executable: typeof v === "string" ? false : v.executable }]));
const read = (rel: string) => fs.readFileSync(path.join(stage, rel), "utf-8");
const ino = (rel = "") => fs.statSync(path.join(stage, rel)).ino;
const tree = (dir = stage, prefix = ""): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [`${prefix}${e.name}/`, ...tree(path.join(dir, e.name), `${prefix}${e.name}/`)] : [`${prefix}${e.name}`])).sort();

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stage-sync-")));
  stage = path.join(root, ".jinn-departments", "alpha");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("syncing a stage directory", () => {
  it("creates it from nothing, with execute bits kept", () => {
    syncStageDir(stage, files({ "CLAUDE.md": "hello", ".claude/skills/review/SKILL.md": "skill", ".claude/skills/review/run.sh": { text: "#!/bin/sh\n", executable: true } }));
    expect(read("CLAUDE.md")).toBe("hello");
    expect(fs.statSync(path.join(stage, ".claude/skills/review/run.sh")).mode & 0o100).toBe(0o100);
    expect(fs.statSync(path.join(stage, "CLAUDE.md")).mode & 0o100).toBe(0);
  });

  it("keeps the directory's path and inode across an update, and renames changed files in", () => {
    const first = files({ "CLAUDE.md": "one", ".claude/skills/review/SKILL.md": "a" });
    syncStageDir(stage, first);
    const dirIno = ino();
    const skillDirIno = ino(".claude/skills/review");
    syncStageDir(stage, files({ "CLAUDE.md": "two", ".claude/skills/review/SKILL.md": "b" }));
    expect(ino()).toBe(dirIno);
    // Directories are made once and never renamed over: a changed file inside a kept skill leaves its directory alone.
    expect(ino(".claude/skills/review")).toBe(skillDirIno);
    expect(read("CLAUDE.md")).toBe("two");
    expect(read(".claude/skills/review/SKILL.md")).toBe("b");
  });

  it("does not touch a file that has not changed", () => {
    const set = files({ "CLAUDE.md": "same", ".claude/skills/review/SKILL.md": "same" });
    syncStageDir(stage, set);
    const before = [ino("CLAUDE.md"), ino(".claude/skills/review/SKILL.md")];
    const report = syncStageDir(stage, set);
    expect(report.written).toEqual([]);
    expect(report.removed).toEqual([]);
    expect([ino("CLAUDE.md"), ino(".claude/skills/review/SKILL.md")]).toEqual(before);
  });

  it("reverts an edit a session made, and restores a deleted file", () => {
    const set = files({ "CLAUDE.md": "generated", ".claude/skills/review/SKILL.md": "skill" });
    syncStageDir(stage, set);
    fs.writeFileSync(path.join(stage, "CLAUDE.md"), "edited by the session");
    fs.rmSync(path.join(stage, ".claude/skills/review/SKILL.md"));
    const dirIno = ino();
    syncStageDir(stage, set);
    expect(read("CLAUDE.md")).toBe("generated");
    expect(read(".claude/skills/review/SKILL.md")).toBe("skill");
    expect(ino()).toBe(dirIno);
  });

  it("restores a stage directory that was emptied", () => {
    const set = files({ "CLAUDE.md": "generated", ".claude/skills/review/SKILL.md": "skill" });
    syncStageDir(stage, set);
    for (const entry of fs.readdirSync(stage)) fs.rmSync(path.join(stage, entry), { recursive: true });
    const dirIno = ino();
    syncStageDir(stage, set);
    expect(tree()).toEqual([".claude/", ".claude/skills/", ".claude/skills/review/", ".claude/skills/review/SKILL.md", "CLAUDE.md"]);
    expect(ino()).toBe(dirIno);
  });

  it("removes a file that left a skill that is kept, and a skill that was dropped", () => {
    syncStageDir(stage, files({
      "CLAUDE.md": "x", ".claude/skills/review/SKILL.md": "a", ".claude/skills/review/old/notes.md": "gone soon", ".claude/skills/plan/SKILL.md": "p",
    }));
    const report = syncStageDir(stage, files({ "CLAUDE.md": "x", ".claude/skills/review/SKILL.md": "a" }));
    expect(tree()).toEqual([".claude/", ".claude/skills/", ".claude/skills/review/", ".claude/skills/review/SKILL.md", "CLAUDE.md"]);
    expect(report.removed.sort()).toEqual([".claude/skills/plan", ".claude/skills/review/old"]);
  });

  it("removes files nobody generated, links included", () => {
    syncStageDir(stage, files({ "CLAUDE.md": "x" }));
    fs.writeFileSync(path.join(stage, "scratch.txt"), "a session wrote this");
    fs.mkdirSync(path.join(stage, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(stage, ".claude/settings.local.json"), "{}");
    fs.symlinkSync(root, path.join(stage, "escape"));
    syncStageDir(stage, files({ "CLAUDE.md": "x" }));
    expect(tree()).toEqual(["CLAUDE.md"]);
  });

  it("handles a path that changes type, in both directions", () => {
    syncStageDir(stage, files({ "a": "was a file", "b/inner.md": "was a dir" }));
    syncStageDir(stage, files({ "a/inner.md": "now a dir", "b": "now a file" }));
    expect(tree()).toEqual(["a/", "a/inner.md", "b"]);
    expect(read("a/inner.md")).toBe("now a dir");
    expect(read("b")).toBe("now a file");
  });

  it("changes an execute bit", () => {
    syncStageDir(stage, files({ "run.sh": { text: "same", executable: false } }));
    syncStageDir(stage, files({ "run.sh": { text: "same", executable: true } }));
    expect(fs.statSync(path.join(stage, "run.sh")).mode & 0o100).toBe(0o100);
  });

  it("replaces a link where the directory belongs, and leaves no incoming directory behind", () => {
    fs.mkdirSync(path.dirname(stage), { recursive: true });
    fs.symlinkSync(root, stage);
    syncStageDir(stage, files({ "CLAUDE.md": "x" }));
    expect(fs.lstatSync(stage).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.dirname(stage)).filter((n) => n.includes(".incoming-"))).toEqual([]);
    expect(fs.existsSync(path.join(root, "CLAUDE.md"))).toBe(false);
  });

  it("reaps incoming directories older than an hour, and only those", () => {
    syncStageDir(stage, files({ "CLAUDE.md": "x" }));
    const base = path.dirname(stage);
    const stale = path.join(base, ".beta.incoming-abc123");
    const fresh = path.join(base, ".gamma.incoming-def456");
    const unrelated = path.join(base, ".beta.incoming-not-ours-at-all");
    for (const dir of [stale, fresh, unrelated]) fs.mkdirSync(dir);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(unrelated, old, old);
    syncStageDir(stage, files({ "CLAUDE.md": "x" }));
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("refuses a stage root that is a link, and deletes nothing through it", () => {
    const home = path.join(root, "fake-home");
    fs.mkdirSync(path.join(home, "docs"), { recursive: true });
    fs.writeFileSync(path.join(home, "docs", "org.md"), "company doc");
    const linkedRoot = path.join(root, "links", ".jinn-departments");
    fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
    fs.symlinkSync(home, linkedRoot);
    expect(() => syncStageDir(path.join(linkedRoot, "docs"), files({ "CLAUDE.md": "x" }))).toThrow(/is a symbolic link/);
    expect(() => syncStageDir(path.join(linkedRoot, "sales"), files({ "CLAUDE.md": "x" }))).toThrow(/is a symbolic link/);
    expect(fs.readFileSync(path.join(home, "docs", "org.md"), "utf-8")).toBe("company doc");
    expect(fs.existsSync(path.join(home, "sales"))).toBe(false);
  });

  it("refuses a stage directory that resolves inside a forbidden tree, and one that is not directly under its root", () => {
    const home = path.join(root, "fake-home");
    fs.mkdirSync(path.join(home, "docs"), { recursive: true });
    fs.writeFileSync(path.join(home, "docs", "org.md"), "company doc");
    // The root is real but the stage directory name is a link into the home (a session can make one with `ln -s`).
    const realRoot = path.join(root, ".jinn-departments");
    fs.mkdirSync(realRoot);
    fs.symlinkSync(path.join(home, "docs"), path.join(realRoot, "docs"));
    // A link is replaced by a real directory, which is fine and deletes nothing in the home.
    syncStageDir(path.join(realRoot, "docs"), files({ "CLAUDE.md": "x" }), Date.now(), [home]);
    expect(fs.readFileSync(path.join(home, "docs", "org.md"), "utf-8")).toBe("company doc");
    // A root that lies inside a forbidden tree is refused.
    const inside = path.join(home, "stage-root", "alpha");
    expect(() => syncStageDir(inside, files({ "CLAUDE.md": "x" }), Date.now(), [home])).toThrow(/resolves inside/);
  });

  it("leaves another department's stage directory alone", () => {
    const other = path.join(path.dirname(stage), "beta");
    syncStageDir(other, files({ "CLAUDE.md": "beta's" }));
    syncStageDir(stage, files({ "CLAUDE.md": "alpha's" }));
    expect(fs.readFileSync(path.join(other, "CLAUDE.md"), "utf-8")).toBe("beta's");
  });
});

describe("generating a stage file set", () => {
  let home: string;
  const skill = (name: string, extra: (dir: string) => void = () => {}) => {
    const dir = path.join(home, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
    extra(dir);
  };
  const instructions = (text: string) => {
    const dir = path.join(home, "knowledge", "departments", "alpha");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "INSTRUCTIONS.md"), text);
  };
  const generate = (instr: "department" | "department+company" = "department", skills: string[] = ["review"]) =>
    generateStageFileSet({ home, slug: "alpha", definition: { skills, instructions: instr } });
  const text = (set: StageFileSet, rel: string) => set.get(rel)?.content.toString("utf-8");

  beforeEach(() => {
    home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "CLAUDE.md"), "# Company instructions\n");
  });

  it("returns the file set and writes nothing", () => {
    skill("review");
    instructions("Be careful.\n");
    const before = tree(root);
    const { files: set } = generate();
    expect(tree(root)).toEqual(before);
    expect([...set.keys()].sort()).toEqual([".claude/skills/review/SKILL.md", "CLAUDE.md"]);
  });

  it("builds CLAUDE.md from the instructions and ends it with the scope paragraph, without the company file by default", () => {
    instructions("Be careful.\n");
    const md = text(generate().files, "CLAUDE.md")!;
    expect(md.startsWith("Be careful.\n\n## Department scope")).toBe(true);
    expect(md).toContain("scoped to the **alpha** department");
    expect(md).toContain("knowledge/departments/alpha/state.md");
    expect(md).not.toContain("Company instructions");
    expect(md.trimEnd().endsWith("through the note tools.")).toBe(true);
  });

  it("appends the company CLAUDE.md between the instructions and the paragraph when the department asks", () => {
    instructions("Be careful.\n");
    const md = text(generate("department+company").files, "CLAUDE.md")!;
    expect(md.indexOf("Be careful.")).toBeLessThan(md.indexOf("# Company instructions"));
    expect(md.indexOf("# Company instructions")).toBeLessThan(md.indexOf("## Department scope"));
  });

  it("is just the paragraph when the department has no instructions, and when it has no definition", () => {
    expect(text(generate().files, "CLAUDE.md")!.startsWith("## Department scope")).toBe(true);
    const bare = generateStageFileSet({ home, slug: "alpha", definition: null });
    expect([...bare.files.keys()]).toEqual(["CLAUDE.md"]);
  });

  it("copies exactly the allow-listed skills, with every file and the execute bit", () => {
    skill("review", (dir) => {
      fs.mkdirSync(path.join(dir, "scripts"));
      fs.writeFileSync(path.join(dir, "scripts", "go.sh"), "#!/bin/sh\n", { mode: 0o755 });
    });
    skill("other");
    const { files: set } = generate("department", ["review"]);
    expect([...set.keys()].sort()).toEqual([".claude/skills/review/SKILL.md", ".claude/skills/review/scripts/go.sh", "CLAUDE.md"]);
    expect(set.get(".claude/skills/review/scripts/go.sh")!.executable).toBe(true);
  });

  it("refuses a skill that contains a symlink, and says so", () => {
    const warn = vi.spyOn(logger, "warn");
    skill("review", (dir) => fs.symlinkSync(path.join(home, "CLAUDE.md"), path.join(dir, "link.md")));
    skill("plan");
    const { files: set, refused } = generate("department", ["review", "plan"]);
    expect([...set.keys()].sort()).toEqual([".claude/skills/plan/SKILL.md", "CLAUDE.md"]);
    expect(refused).toEqual([{ skill: "review", reason: "it contains a symlink (link.md)" }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skill "review" is left out'));
  });

  it("refuses a skill whose directory is itself a link, and one that is not installed", () => {
    const real = path.join(root, "elsewhere");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "SKILL.md"), "x");
    fs.mkdirSync(path.join(home, "skills"), { recursive: true });
    fs.symlinkSync(real, path.join(home, "skills", "linked"));
    const { files: set, refused } = generate("department", ["linked", "missing"]);
    expect([...set.keys()]).toEqual(["CLAUDE.md"]);
    expect(refused.map((r) => r.skill)).toEqual(["linked", "missing"]);
  });

  it("ignores an INSTRUCTIONS.md that is a link", () => {
    const dir = path.join(home, "knowledge", "departments", "alpha");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(home, "CLAUDE.md"), path.join(dir, "INSTRUCTIONS.md"));
    expect(text(generate().files, "CLAUDE.md")).not.toContain("Company instructions");
  });
});
