import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CronJob } from "../../shared/types.js";
import { parseRules } from "../settings.js";
import { describeSeed, seedBoardWalk } from "../seed.js";
import { BOARD_WALK_JOB_ID, boardWalkCronHandler, findBoardWalkJob, seedBoardWalkJob, stripRetiredKeys, tickRunResult } from "../job.js";

/**
 * The walk's schedule is the `board-walk` cron job. These tests hold the two
 * ways an instance gets it: a fresh install seeded with the defaults, and an
 * upgrade from a file whose frontmatter still carries `enabled`, `schedule` and
 * `timezone` — moved into the job once, the file otherwise left as it was.
 */

const TEMPLATE_DIR = path.resolve(__dirname, "..", "..", "..", "template");
const TEMPLATE = fs.readFileSync(path.join(TEMPLATE_DIR, "board-walk.md"), "utf-8");
const BODY = TEMPLATE.slice(TEMPLATE.indexOf("\n---\n") + 5);

/** The frontmatter the previous release shipped, before the schedule moved. */
const OLD_FRONTMATTER = [
  "---",
  "# The board walk: a scheduled pass over the board that releases Todos whose",
  "# gate is met and decides what to start on spare capacity. Edits take effect",
  "# at the next tick; no restart is needed. Upgrades never overwrite this file.",
  "enabled: true",
  "# Cron expression. Hourly, on the hour.",
  'schedule: "0 * * * *"',
  '# IANA zone for the schedule and for "local time" below. Empty = the gateway host\'s zone.',
  'timezone: ""',
  "# Who the walk's one turn per tick runs as. It always runs on Claude, on the",
  "# gateway, with no tools: the walk decides and the gateway acts.",
  "employee: assistant",
  "# Claude model for that turn. Empty = the employee's own, or Claude's default.",
  "model: sonnet",
  "# Hard switches. false means the gateway refuses that action whatever the prose",
  "# below says. The prose can narrow what a switch allows; it cannot widen it.",
  "actions:",
  "  release: true",
  "  park: true",
  "  flagStuck: true",
  "  dispatch: true",
  "  comment: true",
  "---",
  "",
].join("\n");
const OLD_FILE = OLD_FRONTMATTER + BODY;

const NOW = new Date("2026-10-02T09:00:00Z");

function home(files: { rules?: string; jobs?: unknown; config?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-board-walk-job-"));
  if (files.rules !== undefined) fs.writeFileSync(path.join(dir, "board-walk.md"), files.rules);
  if (files.jobs !== undefined) {
    fs.mkdirSync(path.join(dir, "cron"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cron", "jobs.json"), typeof files.jobs === "string" ? files.jobs : JSON.stringify(files.jobs));
  }
  if (files.config !== undefined) fs.writeFileSync(path.join(dir, "config.yaml"), files.config);
  return dir;
}
const jobsIn = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "cron", "jobs.json"), "utf-8")) as CronJob[];
const rulesIn = (dir: string) => fs.readFileSync(path.join(dir, "board-walk.md"), "utf-8");
const seed = (dir: string) => seedBoardWalk({ home: dir, templateDir: TEMPLATE_DIR, now: () => NOW });

const OTHER: CronJob = { id: "nightly", name: "Nightly", enabled: true, schedule: "0 3 * * *", prompt: "summarise the day" };

describe("a fresh install", () => {
  it("gets the stock rules file with no schedule in it, and an hourly board-walk job", () => {
    const dir = home();
    seed(dir);
    expect(rulesIn(dir)).toBe(TEMPLATE);
    expect(parseRules(TEMPLATE).retiredKeys).toEqual([]);
    expect(jobsIn(dir)).toEqual([{ id: "board-walk", name: "Board walk", enabled: true, schedule: "0 * * * *", prompt: "", action: "board-walk" }]);
    // A second boot changes nothing and says nothing.
    expect(describeSeed(seed(dir))).toBeUndefined();
    expect(jobsIn(dir)).toHaveLength(1);
  });

  it("keeps every job already in jobs.json", () => {
    const dir = home({ jobs: [OTHER] });
    seed(dir);
    expect(jobsIn(dir).map((job) => job.id)).toEqual(["nightly", "board-walk"]);
    expect(jobsIn(dir)[0]).toEqual(OTHER);
  });
});

describe("an upgrade from a file that carried the schedule", () => {
  it("moves enabled, schedule and timezone into the job, keeps a copy, and leaves the rest of the file as it was", () => {
    const old = OLD_FRONTMATTER
      .replace("enabled: true", "enabled: false")
      .replace('schedule: "0 * * * *"', 'schedule: "*/30 9-17 * * 1-5"')
      .replace('timezone: ""', 'timezone: "Europe/London"')
      .replace("model: sonnet", "model: opus") + BODY.replace("## Your own rules\n\nAdd anything else here, in plain words.", "## Your own rules\n\nNever start anything on Fridays.");
    const dir = home({ rules: old, jobs: [OTHER] });
    const result = seed(dir);

    expect(jobsIn(dir)).toEqual([OTHER, { id: "board-walk", name: "Board walk", enabled: false, schedule: "*/30 9-17 * * 1-5", timezone: "Europe/London", prompt: "", action: "board-walk" }]);
    const now = rulesIn(dir);
    const before = parseRules(old);
    const after = parseRules(now);
    expect(after.retiredKeys).toEqual([]);
    expect(after.problems).toEqual([]);
    expect(after.settings).toEqual(before.settings);
    // The prose is the operator's, byte for byte.
    expect(after.body).toBe(before.body);
    expect(now.slice(now.indexOf("\n---\n"))).toBe(old.slice(old.indexOf("\n---\n")));
    // The stock comments that described the moved keys go with them; the
    // operator is told where the schedule went.
    expect(now).not.toContain("# Cron expression.");
    expect(now).not.toContain("# IANA zone for the schedule");
    expect(now).toContain('# When the walk runs is the cron job "board-walk"');
    // The same words as the shipped file, including where "local time" comes from.
    expect(now).toContain('# one "local time" below is read in (none = the gateway host\'s zone).');
    expect(TEMPLATE).toContain('# one "local time" below is read in (none = the gateway host\'s zone).');
    expect(now).toContain("# Who the walk's one turn per tick runs as.");
    expect(fs.readFileSync(result.job!.rulesBackupPath!, "utf-8")).toBe(old);
    expect(describeSeed(result)).toMatch(/added the "board-walk" cron job from board-walk.md: \*\/30 9-17 \* \* 1-5 \(Europe\/London\), switched off; moved enabled, schedule, timezone out of board-walk.md \(old file: .*board-walk.md.pre-cron-/);

    // Once only: a second boot neither re-adds the job nor touches the file.
    expect(describeSeed(seed(dir))).toBeUndefined();
    expect(jobsIn(dir)).toHaveLength(2);
    expect(rulesIn(dir)).toBe(now);
  });

  it("the previous stock file becomes an hourly job in the host's zone, and nothing is scheduled twice", () => {
    const dir = home({ rules: OLD_FILE });
    seed(dir);
    const walks = jobsIn(dir).filter((job) => job.action === "board-walk");
    expect(walks).toEqual([{ id: "board-walk", name: "Board walk", enabled: true, schedule: "0 * * * *", prompt: "", action: "board-walk" }]);
    expect(parseRules(rulesIn(dir)).retiredKeys).toEqual([]);
  });

  it("an old schedule the old walk would not have armed makes a switched-off job, so nothing starts that was not running", () => {
    const dir = home({ rules: OLD_FILE.replace('schedule: "0 * * * *"', "schedule: every hour") });
    const result = seed(dir);
    expect(findBoardWalkJob(jobsIn(dir))).toMatchObject({ enabled: false, schedule: "0 * * * *" });
    expect(result.job!.notes).toEqual([expect.stringContaining('schedule "every hour" is not a valid cron expression')]);

    const zone = home({ rules: OLD_FILE.replace('timezone: ""', "timezone: Mars/Olympus") });
    seed(zone);
    expect(findBoardWalkJob(jobsIn(zone))).toMatchObject({ enabled: false });
    expect(findBoardWalkJob(jobsIn(zone))!.timezone).toBeUndefined();
  });

  it("carries a converted gateway.idleCapacity block's zone into the job", () => {
    const dir = home({ config: "gateway:\n  idleCapacity:\n    enabled: true\n    timezone: America/New_York\n" });
    const result = seed(dir);
    expect(result).toMatchObject({ seeded: true, converted: true, removedBlock: true });
    expect(findBoardWalkJob(jobsIn(dir))).toMatchObject({ enabled: true, schedule: "0 * * * *", timezone: "America/New_York" });
    expect(parseRules(rulesIn(dir)).retiredKeys).toEqual([]);
  });

  it("keeps a converted block's zone for the next boot when the job cannot be written on this one", () => {
    const dir = home({ config: "gateway:\n  idleCapacity:\n    enabled: true\n    timezone: America/New_York\n", jobs: "{ broken" });
    expect(seed(dir)).toMatchObject({ converted: true, removedBlock: true, job: { error: expect.stringMatching(/not valid JSON/) } });
    fs.writeFileSync(path.join(dir, "cron", "jobs.json"), "[]");
    // The block is gone from config.yaml now; the zone still reaches the job.
    expect(seed(dir).job).toMatchObject({ created: true });
    expect(findBoardWalkJob(jobsIn(dir))).toMatchObject({ timezone: "America/New_York" });
    expect(fs.existsSync(path.join(dir, "state", "board-walk-job-zone.json"))).toBe(false);
  });

  it("leaves the keys in place, unread, when the rewrite cannot be shown to be the same file", () => {
    const old = "---\ntimezone: &zone UTC\nemployee: assistant\nnote: *zone\n---\n# Mine\n";
    expect(stripRetiredKeys(old)).toBeNull();
    const dir = home({ rules: old });
    const result = seed(dir);
    expect(rulesIn(dir)).toBe(old);
    expect(findBoardWalkJob(jobsIn(dir))).toMatchObject({ timezone: "UTC" });
    expect(describeSeed(result)).toMatch(/timezone in board-walk.md is no longer read/);
  });
});

describe("line endings", () => {
  it("keeps a CRLF file CRLF, wherever the moved keys sat", () => {
    for (const text of [
      "---\r\nemployee: a\r\ntimezone: \"\"\r\n---\r\nbody\r\n",
      "---\r\nenabled: true\r\nemployee: a\r\nschedule: \"0 * * * *\"\r\n---\r\nbody\r\n",
      OLD_FILE.replace(/\n/g, "\r\n"),
    ]) {
      const stripped = stripRetiredKeys(text)!.text;
      expect(stripped).not.toMatch(/\r\r/);
      expect(stripped.replace(/\r\n/g, "")).not.toContain("\n");
      expect(parseRules(stripped).retiredKeys).toEqual([]);
      expect(stripped.endsWith(text.slice(text.lastIndexOf("\r\n---\r\n")))).toBe(true);
    }
  });
});

describe("what the seed leaves alone", () => {
  it("an existing board-walk job is the operator's: not re-added, not changed, and stale keys are only reported", () => {
    const mine: CronJob = { id: "walk", name: "My walk", enabled: false, schedule: "15 * * * *", prompt: "", action: "board-walk" };
    const dir = home({ rules: OLD_FILE, jobs: [mine] });
    const result = seed(dir);
    expect(jobsIn(dir)).toEqual([mine]);
    expect(rulesIn(dir)).toBe(OLD_FILE);
    expect(result.job).toMatchObject({ created: false, ignoredKeys: ["enabled", "schedule", "timezone"] });
  });

  it("a deleted job stays deleted, and the boot log says the walk now runs only by hand", () => {
    const dir = home();
    seed(dir);
    fs.writeFileSync(path.join(dir, "cron", "jobs.json"), "[]");
    const result = seed(dir);
    expect(jobsIn(dir)).toEqual([]);
    expect(describeSeed(result)).toMatch(/cron job was deleted, so the walk runs only when started by hand/);
  });

  it("never rewrites a jobs.json it cannot read, and moves nothing out of the file", () => {
    const dir = home({ rules: OLD_FILE, jobs: "[{ not json" });
    const result = seed(dir);
    expect(fs.readFileSync(path.join(dir, "cron", "jobs.json"), "utf-8")).toBe("[{ not json");
    expect(rulesIn(dir)).toBe(OLD_FILE);
    expect(result.job!.error).toMatch(/not valid JSON/);
    // Not marked, so the next boot tries again once the file is fixed.
    fs.writeFileSync(path.join(dir, "cron", "jobs.json"), "[]");
    expect(seed(dir).job).toMatchObject({ created: true });
  });

  it("does not take an id that a prompt job already has", () => {
    const squatter: CronJob = { ...OTHER, id: BOARD_WALK_JOB_ID };
    const dir = home({ jobs: [squatter] });
    const result = seedBoardWalkJob({ home: dir, now: () => NOW });
    expect(result.error).toMatch(/already exists and is not the board walk/);
    expect(jobsIn(dir)).toEqual([squatter]);
  });
});

describe("a tick as a cron run", () => {
  const tick = { at: NOW.toISOString(), trigger: "schedule" as const, entries: [] };
  it("a skipped or idle tick is a successful run, a failed one is an error with its reason", () => {
    expect(tickRunResult({ ...tick, outcome: "ok", summary: "nothing to do", sessionId: "s1" })).toEqual({ status: "success", summary: "ok: nothing to do", sessionId: "s1" });
    expect(tickRunResult({ ...tick, outcome: "busy", summary: "skipped" }).status).toBe("success");
    expect(tickRunResult({ ...tick, outcome: "failed", summary: "the model turn failed: x" })).toMatchObject({ status: "error", error: "the model turn failed: x" });
    expect(tickRunResult({ ...tick, outcome: "invalid-rules", summary: "bad" }).status).toBe("error");
  });

  it("a run-now that joins a running tick says so in its run", async () => {
    const running = { ...tick, outcome: "ok" as const, summary: "nothing to do", at: new Date(Date.parse(tick.at) - 5_000).toISOString() };
    const joined = await boardWalkCronHandler({ tick: async () => running }, () => Date.parse(tick.at))({} as CronJob, "manual");
    expect(joined.summary).toBe("joined the tick already running: ok: nothing to do");
    const fresh = await boardWalkCronHandler({ tick: async () => ({ ...running, at: tick.at }) }, () => Date.parse(tick.at))({} as CronJob, "manual");
    expect(fresh.summary).toBe("ok: nothing to do");
  });

  it("the scheduler's job is the first enabled one with the action", () => {
    const a: CronJob = { id: "a", name: "A", enabled: false, schedule: "0 * * * *", prompt: "", action: "board-walk" };
    const b: CronJob = { ...a, id: "b", enabled: true };
    expect(findBoardWalkJob([OTHER, a, b])?.id).toBe("b");
    expect(findBoardWalkJob([OTHER, a])?.id).toBe("a");
    expect(findBoardWalkJob([OTHER])).toBeUndefined();
  });
});
