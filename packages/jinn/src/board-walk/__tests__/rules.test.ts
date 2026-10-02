import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { BOARD_WALK_DEFAULTS, parseRules, readRules, splitFrontmatter } from "../settings.js";
import {
  convertLegacyBlock,
  intervalToCron,
  renderDispatchSection,
  replaceDispatchSection,
  resolveLegacyPolicy,
} from "../legacy-idle-capacity.js";
import { describeSeed, seedBoardWalk } from "../seed.js";

const TEMPLATE_DIR = path.resolve(__dirname, "..", "..", "..", "template");
const TEMPLATE = fs.readFileSync(path.join(TEMPLATE_DIR, "board-walk.md"), "utf-8");

function dispatchSection(text: string): string {
  const start = text.search(/^## Dispatch$/m);
  const rest = text.slice(start + 1);
  const next = rest.search(/^## /m);
  return text.slice(start, next === -1 ? undefined : start + 1 + next).trim();
}

describe("board-walk.md settings", () => {
  it("the shipped template parses with no problems and the stock settings", () => {
    const rules = parseRules(TEMPLATE);
    expect(rules.problems).toEqual([]);
    expect(rules.settings).toMatchObject({
      enabled: true, schedule: "0 * * * *", employee: "assistant", model: "sonnet",
      actions: { release: true, park: true, flagStuck: true, dispatch: true, comment: true },
    });
    // An empty timezone is the host's zone, never an invalid one.
    expect(rules.settings.timezone).toBeTruthy();
    expect(rules.body.startsWith("# Board walk")).toBe(true);
  });

  it("switches each action off on its own", () => {
    const rules = parseRules("---\nactions:\n  dispatch: false\n---\nbody");
    expect(rules.settings.actions).toEqual({ ...BOARD_WALK_DEFAULTS.actions, dispatch: false });
    expect(rules.problems).toEqual([]);
  });

  it("reports what is wrong instead of guessing", () => {
    const rules = parseRules("---\nenabled: maybe\nschedule: every hour\ntimezone: Mars/Olympus\nactions:\n  dispatch: no-thanks\n  launch: true\n---\n");
    expect(rules.problems).toEqual(expect.arrayContaining([
      "enabled must be true or false",
      "schedule: schedule must be a valid cron expression",
      expect.stringContaining("timezone"),
      "actions.dispatch must be true or false",
      expect.stringContaining("actions.launch is not an action"),
    ]));
  });

  it("refuses frontmatter that is not YAML, and a missing file", () => {
    expect(parseRules("---\n: : :\n  - [\n---\n").problems[0]).toMatch(/not valid YAML/);
    const missing = readRules(path.join(os.tmpdir(), "no-such-board-walk.md"));
    expect(missing.exists).toBe(false);
    expect(missing.problems).toEqual(["board-walk.md does not exist"]);
  });

  it("an empty model means the employee's own", () => {
    expect(parseRules("---\nmodel: \"\"\n---\n").settings.model).toBeUndefined();
    expect(splitFrontmatter("no frontmatter here").frontmatter).toBeNull();
  });
});

describe("converting gateway.idleCapacity into prose", () => {
  it("the shipped Dispatch section is the old defaults, stated in prose", () => {
    expect(renderDispatchSection(resolveLegacyPolicy(undefined))).toBe(dispatchSection(TEMPLATE));
  });

  it("carries a custom block's numbers, zone, interval and label, and keeps dispatch off when the loop was off", () => {
    const block = {
      intervalMinutes: 15,
      timezone: "America/New_York",
      quietHours: { start: "23:00", end: "07:00" },
      operatorActivity: { idleMinutes: 45, usageDeltaPercent: 3 },
      tiers: { daytime: { fiveHour: { maxUsedPercent: 40, lookaheadMinutes: 90 }, maxDispatchesPerWindow: 4 }, interactive: { enabled: false } },
      requireLabel: "auto-ok",
    };
    const { text, notes } = convertLegacyBlock(TEMPLATE, block);
    const rules = parseRules(text);
    expect(rules.problems).toEqual([]);
    expect(rules.settings).toMatchObject({ timezone: "America/New_York", schedule: "*/15 * * * *" });
    expect(rules.settings.actions.dispatch).toBe(false);
    const section = dispatchSection(text);
    expect(section).toContain("within the last 45 minutes");
    expect(section).toContain("by 3 points or");
    expect(section).toContain("23:00 to 07:00 local time");
    expect(section).toContain("| Daytime | outside quiet hours, operator not live | 40% | 75% | 90 minutes (5-hour window) or 24 hours (weekly) | 4 |");
    expect(section).toContain("| Operator live | any time | never start | never start | — | 0 |");
    expect(section).toContain("Never start anything in these situations: operator live.");
    expect(section).toContain("Only Todos labelled `auto-ok`.");
    // Every other section is the template's, untouched.
    expect(text.replace(section, "")).toBe(TEMPLATE.replace(dispatchSection(TEMPLATE), "").replace('timezone: ""', 'timezone: "America/New_York"').replace('schedule: "0 * * * *"', 'schedule: "*/15 * * * *"').replace(/^(\s+dispatch:) true$/m, "$1 false"));
    expect(notes).toEqual(expect.arrayContaining([expect.stringContaining("schedule */15"), "dispatch off (the auto-start was not enabled)"]));
  });

  it("an enabled block keeps dispatch on, and an absent interval keeps the hourly default", () => {
    const rules = parseRules(convertLegacyBlock(TEMPLATE, { enabled: true }).text);
    expect(rules.settings.actions.dispatch).toBe(true);
    expect(rules.settings.schedule).toBe("0 * * * *");
    expect(rules.settings.timezone).toBe("Europe/London");
  });

  it("states different concurrency per situation when the tiers differ", () => {
    const section = renderDispatchSection(resolveLegacyPolicy({ tiers: { overnight: { maxActiveSessions: 3 } } }));
    expect(section).toContain("overnight: while 3 or more sessions already hold engine capacity");
    expect(section).toContain("daytime: while any session already holds engine capacity");
  });

  it("turns an interval into the nearest cron step", () => {
    expect(intervalToCron(10)).toBe("*/10 * * * *");
    expect(intervalToCron(60)).toBe("0 * * * *");
    expect(intervalToCron(180)).toBe("0 */3 * * *");
    expect(intervalToCron(5000)).toBe("0 0 * * *");
  });

  it("appends a Dispatch section to a file that lost it", () => {
    expect(replaceDispatchSection("# Board walk\n\nnothing else\n", "## Dispatch\n\nrules")).toBe("# Board walk\n\nnothing else\n\n## Dispatch\n\nrules\n");
  });
});

describe("seeding board-walk.md", () => {
  const fresh = (config?: string) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-board-walk-seed-"));
    if (config !== undefined) fs.writeFileSync(path.join(home, "config.yaml"), config);
    return home;
  };
  const opts = (home: string) => ({ home, templateDir: TEMPLATE_DIR, now: () => new Date("2026-10-02T09:00:00Z") });
  const readConfig = (home: string) => yaml.load(fs.readFileSync(path.join(home, "config.yaml"), "utf-8")) as Record<string, any>;

  it("a fresh install gets the stock file and no idleCapacity config", () => {
    const home = fresh("gateway:\n  port: 7777\nengines:\n  claude: {}\n");
    const result = seedBoardWalk(opts(home));
    expect(result).toMatchObject({ seeded: true, converted: false, removedBlock: false });
    expect(fs.readFileSync(path.join(home, "board-walk.md"), "utf-8")).toBe(TEMPLATE);
    expect(readConfig(home).gateway.idleCapacity).toBeUndefined();
    expect(describeSeed(result)).toBe("Board walk: created board-walk.md from the template");
  });

  it("an upgrade leaves an edited file untouched, and a second run does nothing", () => {
    const home = fresh("gateway:\n  port: 7777\n");
    const edited = "---\nenabled: false\n---\n# Mine\n";
    fs.writeFileSync(path.join(home, "board-walk.md"), edited);
    expect(seedBoardWalk(opts(home))).toMatchObject({ seeded: false, removedBlock: false });
    expect(fs.readFileSync(path.join(home, "board-walk.md"), "utf-8")).toBe(edited);
    expect(describeSeed(seedBoardWalk(opts(home)))).toBeUndefined();
  });

  it("an upgrade from a custom gateway.idleCapacity block writes equivalent prose and removes the block, keeping a backup", () => {
    const home = fresh([
      "gateway:", "  port: 7777", "  idleCapacity:", "    enabled: true", "    tiers:", "      daytime:", "        fiveHour:", "          maxUsedPercent: 35",
      "engines:", "  claude: {}", "",
    ].join("\n"));
    const result = seedBoardWalk(opts(home));
    expect(result).toMatchObject({ seeded: true, converted: true, removedBlock: true, blockDiscarded: false });
    const text = fs.readFileSync(path.join(home, "board-walk.md"), "utf-8");
    expect(text).toContain("| Daytime | outside quiet hours, operator not live | 35% |");
    expect(parseRules(text).settings.actions.dispatch).toBe(true);
    const config = readConfig(home);
    expect(config.gateway).toEqual({ port: 7777 });
    expect(config.engines).toEqual({ claude: {} });
    expect(fs.readFileSync(result.backupPath!, "utf-8")).toContain("maxUsedPercent: 35");
    expect(describeSeed(result)).toMatch(/created board-walk.md from gateway.idleCapacity/);
  });

  it("removes the block without merging it when the file already exists, and says so", () => {
    const home = fresh("gateway:\n  idleCapacity:\n    enabled: true\n");
    fs.writeFileSync(path.join(home, "board-walk.md"), "# Mine\n");
    const result = seedBoardWalk(opts(home));
    expect(result).toMatchObject({ seeded: false, removedBlock: true, blockDiscarded: true });
    expect(fs.readFileSync(path.join(home, "board-walk.md"), "utf-8")).toBe("# Mine\n");
    expect(readConfig(home).gateway).toEqual({});
    expect(describeSeed(result)).toMatch(/WITHOUT merging it/);
  });

  it("reports a failure instead of throwing", () => {
    const home = fresh();
    const result = seedBoardWalk({ ...opts(home), templateDir: path.join(home, "nowhere") });
    expect(result.error).toBeTruthy();
    expect(describeSeed(result)).toMatch(/could not seed/);
  });
});
