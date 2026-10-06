import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FARM_SCRIPT } from "../remote-stage.js";
import { SCOPED_FARM_SCRIPT } from "../remote-department-stage.js";
import { buildStageTar } from "../stage-tar.js";
import type { StageFileSet } from "../../gateway/department-stage/file-set.js";

/**
 * The scoped farm script and the stage tar, run for real under `sh` and the system `tar`
 * against temporary directories (FR-062, SC-007). The sync script has its own file.
 */

describe.skipIf(process.platform === "win32")("SCOPED_FARM_SCRIPT — run for real", () => {
  let dir: string;
  let root: string;
  let home: string;

  const runFarm = (ttlDays = 7): string => execFileSync("sh", ["-c", SCOPED_FARM_SCRIPT, "sh", root, home, String(ttlDays)], { encoding: "utf8" });

  /** Every path under `dir`, relative, directories with a trailing slash. */
  function walk(base: string, rel = ""): string[] {
    return fs.readdirSync(path.join(base, rel), { withFileTypes: true }).flatMap((entry) => {
      const child = path.join(rel, entry.name);
      return entry.isDirectory() ? [`${child}/`, ...walk(base, child)] : [child];
    });
  }

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scoped-farm-")));
    root = path.join(dir, "stage");
    home = path.join(root, "sessions", "s1");
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("leaves a home holding only the stage marker and tmp/, with no link and no CLAUDE.md anywhere", () => {
    runFarm();
    expect(fs.readdirSync(home).sort()).toEqual([".jinn-remote-stage", "tmp"]);
    expect(fs.lstatSync(path.join(home, ".jinn-remote-stage")).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(home, "tmp")).isDirectory()).toBe(true);
    const all = walk(dir);
    expect(all.filter((p) => fs.lstatSync(path.join(dir, p)).isSymbolicLink())).toEqual([]);
    expect(all.filter((p) => path.basename(p) === "CLAUDE.md")).toEqual([]);
  });

  it("removes what an unscoped farm left in the home, without touching the mount it linked to", () => {
    const mount = path.join(dir, "mount");
    fs.mkdirSync(path.join(mount, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(mount, "knowledge", "state.md"), "company state\n");
    fs.writeFileSync(path.join(mount, "CLAUDE.md"), "company rules\n");
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
    fs.symlinkSync(path.join(mount, "knowledge"), path.join(home, "knowledge"));
    fs.symlinkSync(path.join(mount, "CLAUDE.md"), path.join(home, "CLAUDE.md"));
    fs.symlinkSync(path.join(mount, "CLAUDE.md"), path.join(home, "sessions", "link"));
    fs.writeFileSync(path.join(home, "gateway.json"), '{"port":7777}\n');
    fs.writeFileSync(path.join(home, "tmp", "x"), "kept");
    runFarm();
    expect(fs.readdirSync(home).sort()).toEqual([".jinn-remote-stage", "gateway.json", "tmp"]);
    expect(fs.readFileSync(path.join(home, "tmp", "x"), "utf-8")).toBe("kept");
    expect(fs.readFileSync(path.join(mount, "knowledge", "state.md"), "utf-8")).toBe("company state\n");
    expect(fs.readFileSync(path.join(mount, "CLAUDE.md"), "utf-8")).toBe("company rules\n");
  });

  it("reports a per-host asset that is a regular file, and not one that is a link", () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "hook-relay.mjs"), "// relay\n");
    fs.writeFileSync(path.join(dir, "elsewhere.mjs"), "// elsewhere\n");
    fs.symlinkSync(path.join(dir, "elsewhere.mjs"), path.join(root, "remote-trust-seed.mjs"));
    const out = runFarm();
    expect(out.split("\n")).toContain("asset=hook-relay.mjs");
    expect(out).not.toContain("remote-trust-seed.mjs");
  });

  it("reaps a session stage older than the TTL and keeps a fresh one", () => {
    const sessions = path.join(root, "sessions");
    fs.mkdirSync(path.join(sessions, "old"), { recursive: true });
    fs.mkdirSync(path.join(sessions, "fresh"), { recursive: true });
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    fs.utimesSync(path.join(sessions, "old"), tenDaysAgo, tenDaysAgo);
    runFarm(7);
    expect(fs.existsSync(path.join(sessions, "old"))).toBe(false);
    expect(fs.existsSync(path.join(sessions, "fresh"))).toBe(true);
  });

  it("keeps the per-session lock block identical to FARM_SCRIPT's", () => {
    const slice = (script: string): string => {
      const start = script.indexOf('lock="$home.farm-lock"');
      const endMarker = "trap 'exit 1' HUP INT TERM";
      const end = script.indexOf(endMarker, start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return script.slice(start, end + endMarker.length);
    };
    expect(slice(SCOPED_FARM_SCRIPT)).toBe(slice(FARM_SCRIPT));
  });

  it("breaks a stale lock and finishes", () => {
    const lock = `${home}.farm-lock`;
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "taken"), `${Math.floor(Date.now() / 1000) - 60}\n`);
    runFarm();
    expect(fs.existsSync(path.join(home, ".jinn-remote-stage"))).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("buildStageTar", () => {
  const one = (rel: string): StageFileSet => new Map([[rel, { content: Buffer.from("x"), executable: false }]]);

  it("refuses a path that cannot be staged", () => {
    for (const rel of ["/abs/CLAUDE.md", "a/../b", "a//b", "a/./b", "", "a/b\u0001c", `${"s".repeat(160)}/CLAUDE.md`, `${"d/".repeat(60)}${"n".repeat(160)}`]) {
      expect(() => buildStageTar(one(rel)), JSON.stringify(rel)).toThrow();
    }
  });

  it("splits a path over 100 bytes at a slash so the system tar extracts it whole", () => {
    const rel = `${"a".repeat(70)}/${"b".repeat(70)}/CLAUDE.md`;
    expect(Buffer.byteLength(rel)).toBeGreaterThan(100);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "stage-tar-"));
    try {
      execFileSync("tar", ["-x", "-f", "-", "-C", out], { input: buildStageTar(one(rel)) });
      expect(fs.readFileSync(path.join(out, rel), "utf-8")).toBe("x");
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
