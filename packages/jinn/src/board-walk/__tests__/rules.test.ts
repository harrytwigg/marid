import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { BOARD_WALK_DEFAULTS, missingDefaultSections, parseRules, readRules, resolveSettings, splitFrontmatter, withRunnerOverrides } from "../settings.js";
import {
  convertLegacyBlock,
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
    expect(rules.settings).toEqual({
      employee: "assistant", engine: "claude", model: "sonnet",
      actions: { release: true, park: true, flagStuck: true, dispatch: true, comment: true },
    });
    // The schedule is the cron job's: the shipped file carries none of it.
    expect(rules.retiredKeys).toEqual([]);
    expect(rules.body.startsWith("# Board walk")).toBe(true);
  });

  it("switches each action off on its own", () => {
    const rules = parseRules("---\nactions:\n  dispatch: false\n---\nbody");
    expect(rules.settings.actions).toEqual({ ...BOARD_WALK_DEFAULTS.actions, dispatch: false });
    expect(rules.problems).toEqual([]);
  });

  it("reports what is wrong instead of guessing", () => {
    const rules = parseRules("---\nemployee: 7\nactions:\n  dispatch: no-thanks\n  launch: true\n---\n");
    expect(rules.problems).toEqual([
      "employee must be a string (got number)",
      "actions.dispatch must be true or false",
      expect.stringContaining("actions.launch is not an action"),
    ]);
  });

  it("reads the retired schedule keys as nothing, not as a problem", () => {
    const rules = parseRules("---\nenabled: maybe\nschedule: every hour\ntimezone: Mars/Olympus\n---\n");
    expect(rules.problems).toEqual([]);
    expect(rules.retiredKeys).toEqual(["enabled", "schedule", "timezone"]);
    expect(rules.settings).toEqual(BOARD_WALK_DEFAULTS);
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

describe("the walk's runner settings", () => {
  it("defaults to the stock Claude runner, so an install that names none is unchanged", () => {
    expect(resolveSettings({}).settings).toEqual(BOARD_WALK_DEFAULTS);
    // A named engine with no model gets that engine's own default, not Claude's.
    expect(resolveSettings({ engine: "opencode" }).settings).toEqual({ ...BOARD_WALK_DEFAULTS, engine: "opencode", model: undefined });
    expect(resolveSettings({ engine: "opencode", model: "opencode-go/deepseek-v4.1-flash" }).settings)
      .toMatchObject({ engine: "opencode", model: "opencode-go/deepseek-v4.1-flash" });
    expect(resolveSettings({ engine: "claude", effortLevel: "high" }).settings.effortLevel).toBe("high");
  });

  it("refuses an engine this build does not know, and one the walk cannot be confined on", () => {
    expect(resolveSettings({ engine: "nonsense" }).problems).toEqual(['engine "nonsense" is not one of claude, codex, antigravity, grok, pi, hermes, opencode']);
    expect(resolveSettings({ engine: "codex" }).problems).toEqual(['the board walk can only run on claude or opencode, so that its turn has only the walk\'s tools; "codex" cannot be confined to them']);
  });

  it("reads the job's own runner fields over the file's, and leaves the file's where the job is silent", () => {
    const base = resolveSettings({ employee: "assistant", engine: "claude", model: "sonnet" }).settings;
    expect(withRunnerOverrides(base, undefined)).toEqual(base);
    expect(withRunnerOverrides(base, { employee: "coo", engine: "opencode", model: "m", effortLevel: "low" }))
      .toEqual({ ...base, employee: "coo", engine: "opencode", model: "m", effortLevel: "low" });
    // A field the job leaves empty does not blank the file's value.
    expect(withRunnerOverrides(base, { employee: "assistant", engine: "   ", model: undefined, effortLevel: "  " })).toEqual(base);
  });

  it("moves the model with the engine: a job changing the engine drops the file's model", () => {
    const onClaude = resolveSettings({ engine: "claude", model: "sonnet" }).settings;
    // The job names opencode but no model: keeping `sonnet` would run opencode
    // with a Claude id — the exact setup this feature exists to allow.
    expect(withRunnerOverrides(onClaude, { engine: "opencode" })).toEqual({ ...onClaude, engine: "opencode", model: undefined });
    // A job that names a model but the same engine keeps the pair matching.
    expect(withRunnerOverrides(onClaude, { engine: "claude", model: "opus" })).toMatchObject({ engine: "claude", model: "opus" });
    // A job that names only a model inherits the engine in force, so the pair
    // still matches — including a file on opencode, whose model a Claude check
    // would wrongly reject.
    expect(withRunnerOverrides(onClaude, { model: "opus" })).toMatchObject({ engine: "claude", model: "opus" });
    const onOpencode = resolveSettings({ engine: "opencode" }).settings;
    expect(withRunnerOverrides(onOpencode, { model: "opencode-go/deepseek-v4.1-flash" })).toMatchObject({ engine: "opencode", model: "opencode-go/deepseek-v4.1-flash" });
  });
});

describe("shipped defaults for missing sections", () => {
  it("names every shipped section the operator's file leaves out, never 'Your own rules'", () => {
    const mine = "# Board walk\n\n## Gates\n\nOnly dates count.\n\n## dispatch\n\nNever.\n";
    const missing = missingDefaultSections(mine, TEMPLATE).map((section) => section.split("\n")[0]);
    expect(missing).toEqual(["## Release", "## Park plain date gates", "## Flag stuck Todos", "## Comments"]);
    expect(missingDefaultSections(parseRules(TEMPLATE).body, TEMPLATE)).toEqual([]);
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
    const { text, notes, timezone } = convertLegacyBlock(TEMPLATE, block);
    // The zone goes to the walk's cron job, not the file.
    expect(timezone).toBe("America/New_York");
    const rules = parseRules(text);
    expect(rules.problems).toEqual([]);
    // The old loop's interval is not a model schedule: every tick is a turn now.
    expect(rules.retiredKeys).toEqual([]);
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
    expect(text.replace(section, "")).toBe(TEMPLATE.replace(dispatchSection(TEMPLATE), "").replace(/^(\s+dispatch:) true$/m, "$1 false"));
    expect(notes).toEqual(expect.arrayContaining([expect.stringContaining("schedule left hourly (the old loop ticked every 15 min"), "dispatch off (the auto-start was not enabled)"]));
  });

  it("an enabled block keeps dispatch on, and an absent zone is the old default", () => {
    const converted = convertLegacyBlock(TEMPLATE, { enabled: true });
    expect(parseRules(converted.text).settings.actions.dispatch).toBe(true);
    expect(converted.timezone).toBe("Europe/London");
  });

  it("states different concurrency per situation when the tiers differ", () => {
    const section = renderDispatchSection(resolveLegacyPolicy({ tiers: { overnight: { maxActiveSessions: 3 } } }));
    expect(section).toContain("overnight: while 3 or more sessions already hold engine capacity");
    expect(section).toContain("daytime: while any session already holds engine capacity");
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
    expect(describeSeed(result)).toBe('Board walk: created board-walk.md from the template; added the "board-walk" cron job with the default schedule: 0 * * * *, enabled');
  });

  it("an upgrade leaves an edited file untouched, and a second run does nothing", () => {
    const home = fresh("gateway:\n  port: 7777\n");
    const edited = "---\nemployee: cvo\n---\n# Mine\n";
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
