import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STAGE_SYNC_SCRIPT } from "../remote-department-stage.js";
import { buildStageTar } from "../stage-tar.js";

/**
 * STAGE_SYNC_SCRIPT, run for real under `sh` against temporary directories (FR-020a, FR-060,
 * SC-007): the file set arrives as a tar stream on stdin, exactly as it does over ssh.
 */

type Files = Record<string, string | { content: string; executable: boolean }>;

const SLUG = "side-project";
const INCOMING = `.${SLUG}.incoming-AbC123`;

function fileSet(files: Files) {
  return new Map(Object.entries(files).map(([rel, file]) => [rel, typeof file === "string" ? { content: Buffer.from(file), executable: false } : { content: Buffer.from(file.content), executable: file.executable }]));
}

describe.skipIf(process.platform === "win32")("STAGE_SYNC_SCRIPT — run for real", () => {
  let dir: string;
  let root: string;
  let stage: string;

  function run(files: Files, opts: { slug?: string; incoming?: string; forbidden?: string[]; root?: string } = {}) {
    const res = spawnSync("sh", ["-c", STAGE_SYNC_SCRIPT, "sh", opts.root ?? root, opts.slug ?? SLUG, opts.incoming ?? INCOMING, ...(opts.forbidden ?? [])], { input: buildStageTar(fileSet(files)), encoding: "utf8" });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  }
  function sync(files: Files, opts: Parameters<typeof run>[1] = {}) {
    const res = run(files, opts);
    expect(res.code, res.stderr).toBe(0);
    return res;
  }
  const read = (rel: string) => fs.readFileSync(path.join(stage, rel), "utf-8");
  const ino = (rel: string) => fs.statSync(path.join(stage, rel)).ino;
  const names = (p: string) => fs.readdirSync(p).sort();
  const ago = (p: string, ms: number) => { const t = new Date(Date.now() - ms); fs.utimesSync(p, t, t); };

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stage-sync-")));
    root = path.join(dir, ".jinn-departments");
    stage = path.join(root, SLUG);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("creates the stage directory on the first sync with every file, its content and its execute bit", () => {
    const res = sync({ "CLAUDE.md": "rules\n", ".claude/skills/a/SKILL.md": "skill a\n", ".claude/skills/a/run.sh": { content: "#!/bin/sh\n", executable: true } });
    expect(read("CLAUDE.md")).toBe("rules\n");
    expect(read(".claude/skills/a/SKILL.md")).toBe("skill a\n");
    expect(fs.statSync(path.join(stage, ".claude/skills/a/run.sh")).mode & 0o100).toBe(0o100);
    expect(fs.statSync(path.join(stage, "CLAUDE.md")).mode & 0o100).toBe(0);
    expect(res.stdout).toMatch(/written=\d+ removed=\d+/);
    expect(names(root)).toEqual([SLUG]);
    expect(fs.existsSync(path.join(root, `${INCOMING}-lists`))).toBe(false);
  });

  it("keeps the stage directory's inode and an unchanged file's inode, and replaces a changed file", () => {
    sync({ "CLAUDE.md": "rules\n", "keep.md": "same\n" });
    const [stageIno, keepIno, rulesIno] = [fs.statSync(stage).ino, ino("keep.md"), ino("CLAUDE.md")];
    sync({ "CLAUDE.md": "new rules\n", "keep.md": "same\n" });
    expect(fs.statSync(stage).ino).toBe(stageIno);
    expect(ino("keep.md")).toBe(keepIno);
    expect(read("CLAUDE.md")).toBe("new rules\n");
    expect(ino("CLAUDE.md")).not.toBe(rulesIno);
  });

  it("removes a dropped skill, and from a kept skill the file that left the set while replacing the one that changed", () => {
    sync({ "CLAUDE.md": "r", ".claude/skills/a/SKILL.md": "v1", ".claude/skills/a/old.md": "gone soon", ".claude/skills/b/SKILL.md": "b" });
    sync({ "CLAUDE.md": "r", ".claude/skills/a/SKILL.md": "v2" });
    expect(read(".claude/skills/a/SKILL.md")).toBe("v2");
    expect(names(path.join(stage, ".claude/skills"))).toEqual(["a"]);
    expect(names(path.join(stage, ".claude/skills/a"))).toEqual(["SKILL.md"]);
  });

  it("reverts a session's edits: an edited file, a stray file and a stray directory", () => {
    sync({ "CLAUDE.md": "rules\n" });
    fs.writeFileSync(path.join(stage, "CLAUDE.md"), "edited\n");
    fs.writeFileSync(path.join(stage, "stray.txt"), "x");
    fs.mkdirSync(path.join(stage, "stray-dir/deeper"), { recursive: true });
    fs.writeFileSync(path.join(stage, "stray-dir/deeper/y"), "y");
    sync({ "CLAUDE.md": "rules\n" });
    expect(read("CLAUDE.md")).toBe("rules\n");
    expect(names(stage)).toEqual(["CLAUDE.md"]);
  });

  it("replaces a link a session planted at a file path or a directory path, and touches nothing it led to", () => {
    const outsideFile = path.join(dir, "outside.txt");
    const outsideDir = path.join(dir, "outside-dir");
    fs.writeFileSync(outsideFile, "precious\n");
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "keep.txt"), "keep\n");
    const files = { "CLAUDE.md": "rules\n", ".claude/skills/a/SKILL.md": "a" };
    sync(files);
    fs.rmSync(path.join(stage, "CLAUDE.md"));
    fs.symlinkSync(outsideFile, path.join(stage, "CLAUDE.md"));
    fs.rmSync(path.join(stage, ".claude"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(stage, ".claude"));
    sync(files);
    expect(fs.lstatSync(path.join(stage, "CLAUDE.md")).isFile()).toBe(true);
    expect(read("CLAUDE.md")).toBe("rules\n");
    expect(fs.lstatSync(path.join(stage, ".claude")).isDirectory()).toBe(true);
    expect(read(".claude/skills/a/SKILL.md")).toBe("a");
    expect(fs.readFileSync(outsideFile, "utf-8")).toBe("precious\n");
    expect(names(outsideDir)).toEqual(["keep.txt"]);
  });

  it("handles a path that changed from a file to a directory, and from a directory to a file", () => {
    sync({ "notes": "was a file", "docs/readme.md": "was a dir" });
    sync({ "notes/today.md": "now a dir", "docs": "now a file" });
    expect(fs.statSync(path.join(stage, "notes")).isDirectory()).toBe(true);
    expect(read("notes/today.md")).toBe("now a dir");
    expect(fs.statSync(path.join(stage, "docs")).isFile()).toBe(true);
    expect(read("docs")).toBe("now a file");
  });

  it("updates the mode when only the execute bit changed", () => {
    const ownerExec = (rel: string) => fs.statSync(path.join(stage, rel)).mode & 0o100;
    sync({ "a.sh": { content: "same\n", executable: false }, "b.sh": { content: "same\n", executable: true } });
    sync({ "a.sh": { content: "same\n", executable: true }, "b.sh": { content: "same\n", executable: false } });
    expect(ownerExec("a.sh")).toBe(0o100);
    expect(ownerExec("b.sh")).toBe(0);
  });

  it("reaps an incoming directory a dead sync left over an hour ago and keeps a recent one", () => {
    const stale = path.join(root, `.${SLUG}.incoming-AAAAAA`);
    const recent = path.join(root, `.${SLUG}.incoming-BBBBBB`);
    for (const d of [stale, recent]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "x"), "x"); }
    ago(stale, 2 * 3_600_000);
    ago(recent, 5 * 60_000);
    sync({ "CLAUDE.md": "r" });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it("removes a file whose name holds a line break, without touching a path outside the stage that the rest of the name spells", () => {
    sync({ "CLAUDE.md": "r" });
    fs.mkdirSync(path.join(stage, "junk\n.."));
    fs.writeFileSync(path.join(stage, "junk\n..", "victim"), "planted");
    fs.writeFileSync(path.join(stage, "plain\nname"), "planted");
    fs.writeFileSync(path.join(root, "victim"), "outside\n");
    sync({ "CLAUDE.md": "r" });
    expect(names(stage)).toEqual(["CLAUDE.md"]);
    expect(fs.readFileSync(path.join(root, "victim"), "utf-8")).toBe("outside\n");
  });

  describe("refusals", () => {
    const files = { "CLAUDE.md": "rules\n" };

    it("refuses a departments root that is a symbolic link, writing nothing through it", () => {
      const real = path.join(dir, "real-root");
      fs.mkdirSync(real);
      fs.symlinkSync(real, root);
      expect(run(files).code).not.toBe(0);
      expect(fs.readdirSync(real)).toEqual([]);
    });

    it("refuses a forbidden tree that is the departments root's parent, and creates nothing", () => {
      expect(run(files, { forbidden: [dir] }).code).not.toBe(0);
      expect(fs.existsSync(stage)).toBe(false);
    });

    it("refuses a forbidden tree inside the stage directory, and leaves the stage as it was", () => {
      sync(files);
      fs.writeFileSync(path.join(stage, "CLAUDE.md"), "edited\n");
      expect(run(files, { forbidden: [path.join(stage, "inner")] }).code).not.toBe(0);
      expect(read("CLAUDE.md")).toBe("edited\n");
    });

    it("refuses a department name that is hidden or a path, and an incoming name that does not match", () => {
      for (const opts of [{ slug: ".x", incoming: "..x.incoming-AbC123" }, { slug: "a/b", incoming: ".a/b.incoming-AbC123" }, { incoming: ".side-project.incoming-short" }, { incoming: ".other.incoming-AbC123" }]) {
        expect(run(files, opts).code, JSON.stringify(opts)).not.toBe(0);
      }
      expect(fs.existsSync(stage)).toBe(false);
      expect(fs.existsSync(path.join(root, ".x"))).toBe(false);
    });

    it("replaces a stage directory that is a link with a real one, and touches nothing it led to", () => {
      const outside = path.join(dir, "outside-dir");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "keep.txt"), "keep\n");
      fs.mkdirSync(root);
      fs.symlinkSync(outside, stage);
      sync(files);
      expect(fs.lstatSync(stage).isDirectory()).toBe(true);
      expect(read("CLAUDE.md")).toBe("rules\n");
      expect(names(outside)).toEqual(["keep.txt"]);
    });
  });
});
