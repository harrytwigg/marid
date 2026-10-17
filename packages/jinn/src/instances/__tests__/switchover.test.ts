import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A build whose one codename constant says "acme": every name derived from it follows.
vi.mock("../../shared/codename-constant.js", () => ({ CODENAME: "acme" }));

import { builtinMcpServerName } from "../../mcp/builtin-name.js";
import { doctorFindings } from "../../cli/doctor.js";
import { SWITCHOVER_RECEIPT, planSwitchover, readSwitchoverReceipt, switchOver, type SwitchoverOptions } from "../switchover.js";
import { stampVersionInYaml } from "../../migrations/version-marker.js";

let root: string;
let home: string;
let profile: string;
let options: SwitchoverOptions;
const snapshots: string[] = [];

const write = (file: string, text: string): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (...segments: string[]): string => fs.readFileSync(path.join(home, ...segments), "utf-8");

/** An instance as an older build left it: its own block in config.yaml, rosters that say `jinnMcp` and list the built-in
 *  server by name, a skill, a cron prompt and a permission list that call its tools `mcp__jinn__*`, a note, and a session. */
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "switchover-")));
  home = path.join(root, ".acme-john");
  profile = path.join(root, "claude");
  snapshots.length = 0;
  write(path.join(home, "config.yaml"), '# my instance\njinn:\n  version: "0.33.3"   # last migrated\ngateway:\n  port: 8099\n');
  write(path.join(home, "org", "ops", "lead.yaml"), "name: lead\njinnMcp: true  # pilot\nmcp: [jinn, browser]\npersona: leads\n");
  write(path.join(home, "org", "ops", "department.yaml"), "name: ops\nmcp: [jinn]\n");
  write(path.join(home, "skills", "triage", "SKILL.md"), "Call mcp__jinn__list_employees, then mcp__jinn__get_work_item.\n");
  write(path.join(home, "cron", "jobs.json"), JSON.stringify([{ id: "a", prompt: "use mcp__jinn__create_work_item" }]));
  write(path.join(home, ".claude", "settings.json"), '{ "permissions": { "allow": ["mcp__jinn__*", "mcp__jinn", "Bash(ls)"] } }');
  write(path.join(profile, "settings.json"), '{ "permissions": { "allow": ["mcp__jinn__send_to_session"] } }');
  write(path.join(home, "knowledge", "history.md"), "We used mcp__jinn__ tools back then.\n");
  write(path.join(home, "sessions", "registry.db"), "not a database, and not to be scanned");
  options = { home, profileDirs: [profile], gatewayRunning: () => false, backup: async (dir) => { snapshots.push(dir); return path.join(root, "snapshot"), path.join(root, "snapshot"); }, now: new Date("2026-10-17T00:00:00Z") };
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe("reporting a switch-over", () => {
  it("lists what would change and changes nothing", async () => {
    const before = read("config.yaml");
    const report = await switchOver(options);
    const files = report.findings.map((finding) => path.relative(root, finding.file)).sort();
    expect(files).toEqual([
      ".acme-john/.claude/settings.json",
      ".acme-john/config.yaml",
      ".acme-john/cron/jobs.json",
      ".acme-john/org/ops/department.yaml",
      ".acme-john/org/ops/lead.yaml",
      ".acme-john/skills/triage/SKILL.md",
      "claude/settings.json",
    ]);
    expect(report.applied).toBeUndefined();
    expect(read("config.yaml")).toBe(before);
    expect(read("skills", "triage", "SKILL.md")).toContain("mcp__jinn__list_employees");
  });

  it("counts every occurrence, the bare server name in a permission list included", () => {
    const edit = planSwitchover(home, [], { codename: "acme", upper: "ACME", title: "Acme", renamed: true }).find((found) => found.file.endsWith("settings.json"))!;
    expect(edit.count).toBe(2);
    expect(edit.text).toContain('"mcp__acme__*"');
    expect(edit.text).toContain('"mcp__acme"');
    expect(edit.text).toContain('"Bash(ls)"');
  });

  it("leaves notes, sessions and everything it does not read out", async () => {
    const report = await switchOver(options);
    expect(report.findings.some((finding) => /knowledge|sessions/.test(finding.file))).toBe(false);
  });
});

describe("switching an instance over", () => {
  it("rewrites every file, flips the registered name last, and keeps the originals", async () => {
    const report = await switchOver({ ...options, apply: true });
    expect(report.blockers).toEqual([]);
    expect(snapshots).toEqual([home]);

    const config = yaml.load(read("config.yaml")) as Record<string, any>;
    expect(config.acme).toEqual({ version: "0.33.3", mcpServerName: "acme" });
    expect(config.jinn).toBeUndefined();
    expect(builtinMcpServerName(config)).toBe("acme");
    expect(read("config.yaml")).toContain("# my instance");
    expect(read("config.yaml")).toContain("# last migrated");

    expect(read("org", "ops", "lead.yaml")).toContain("acmeMcp: true");
    expect(read("org", "ops", "lead.yaml")).toMatch(/mcp: \[ ?acme, browser ?\]/);
    expect(read("org", "ops", "lead.yaml")).toContain("# pilot");
    expect(read("org", "ops", "department.yaml")).toMatch(/mcp: \[ ?acme ?\]/);
    expect(read("skills", "triage", "SKILL.md")).toBe("Call mcp__acme__list_employees, then mcp__acme__get_work_item.\n");
    expect(JSON.parse(read("cron", "jobs.json"))[0].prompt).toBe("use mcp__acme__create_work_item");
    expect(JSON.parse(read(".claude", "settings.json")).permissions.allow).toEqual(["mcp__acme__*", "mcp__acme", "Bash(ls)"]);
    expect(fs.readFileSync(path.join(profile, "settings.json"), "utf-8")).toContain("mcp__acme__send_to_session");
    // What it does not own is exactly as it was.
    expect(read("knowledge", "history.md")).toContain("mcp__jinn__");

    const receipt = readSwitchoverReceipt(home)!;
    expect(receipt.snapshot).toBe(path.join(root, "snapshot"));
    expect(fs.readFileSync(path.join(receipt.copies, "skills", "triage", "SKILL.md"), "utf-8")).toContain("mcp__jinn__list_employees");
    expect(fs.existsSync(path.join(home, SWITCHOVER_RECEIPT))).toBe(true);
  });

  it("finds nothing left to do the second time, and doctor says so", async () => {
    await switchOver({ ...options, apply: true });
    expect((await switchOver(options)).findings).toEqual([]);
    const findings = doctorFindings({ home, env: {}, instances: [] });
    expect(findings.some((finding) => finding.message.includes('registered as "acme"; switched over'))).toBe(true);
  });

  it("is refused while a gateway runs, and changes nothing", async () => {
    const report = await switchOver({ ...options, apply: true, gatewayRunning: () => true });
    expect(report.blockers[0]).toContain("stop it first");
    expect(read("skills", "triage", "SKILL.md")).toContain("mcp__jinn__");
    expect(snapshots).toEqual([]);
  });

  it("is refused when this build has not been renamed", async () => {
    const same = { codename: "jinn", upper: "JINN", title: "Jinn", renamed: false };
    const report = await switchOver({ ...options, apply: true, names: same });
    expect(report.blockers[0]).toContain("nothing to switch over");
  });

  it("changes nothing when the snapshot fails", async () => {
    const report = await switchOver({ ...options, apply: true, backup: async () => { throw new Error("disk full"); } });
    expect(report.blockers[0]).toContain("disk full");
    expect(read("skills", "triage", "SKILL.md")).toContain("mcp__jinn__");
    expect(read("config.yaml")).toContain("jinn:");
  });

  it("puts back what it had written when a later write fails, and never reaches the flip", async () => {
    const rename = fs.renameSync;
    let writes = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).endsWith(".rename-tmp") && (writes += 1) === 3) throw new Error("denied");
      return rename(from, to);
    });
    const report = await switchOver({ ...options, apply: true });
    vi.restoreAllMocks();
    expect(report.blockers[0]).toContain("rolled back");
    expect(report.applied).toBeUndefined();
    expect(read("skills", "triage", "SKILL.md")).toContain("mcp__jinn__list_employees");
    expect(read("org", "ops", "lead.yaml")).toContain("jinnMcp: true");
    expect(read("config.yaml")).toContain("jinn:");
    expect(fs.readdirSync(path.join(home, "org", "ops")).filter((name) => name.endsWith(".rename-tmp"))).toEqual([]);
  });

  it("creates the instance block when config.yaml has none", async () => {
    write(path.join(home, "config.yaml"), "gateway:\n  port: 8099\n");
    await switchOver({ ...options, apply: true });
    expect((yaml.load(read("config.yaml")) as any).acme).toEqual({ mcpServerName: "acme" });
    expect(stampVersionInYaml(read("config.yaml"), "1.0.0")).toMatchObject({ ok: true });
  });
});
