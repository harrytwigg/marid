import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The plugins watcher against the real chokidar and the real filesystem, because
 * the thing it has to catch is invisible to a double: a double emits whatever the
 * test tells it to, so a watch that never sees a file one directory down still
 * looks like it works. Timers are real here for the same reason.
 *
 * JINN_HOME has to be set before anything reaches paths.js, which reads it once.
 */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-plugins-nested-"));
process.env.JINN_HOME = tmpHome;
const pluginsDir = path.join(tmpHome, "plugins");

/** Room for a filesystem event to reach chokidar, plus the watcher's own 500ms
 *  debounce, on a CI runner with two starved cores. */
const OBSERVE_MS = 15_000;
const CASE_TIMEOUT_MS = 30_000;
/** Longer than the 500ms debounce in the watcher, so an edit lands and settles. */
const EDIT_INTERVAL_MS = 1_200;

let watcher: typeof import("../watcher.js");
const changes = vi.fn();

function callbacks() {
  return {
    onConfigReload: () => {},
    onCronReload: () => {},
    onOrgChange: () => {},
    onSkillsChange: () => {},
    onDepartmentInstructionsChange: () => {},
    onPluginsChange: changes,
  };
}

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, "cron"), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, "skills"), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, "config.yaml"), "gateway: {}\n");
  fs.writeFileSync(path.join(tmpHome, "cron", "jobs.json"), "[]\n");
  watcher = await import("../watcher.js");
});

beforeEach(() => {
  fs.rmSync(pluginsDir, { recursive: true, force: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  changes.mockClear();
});

afterEach(async () => {
  await watcher.stopWatchers();
});

describe("the plugins watcher, unmocked", () => {
  it(
    "rescans when a plugin's server.js is edited",
    async () => {
      const server = path.join(pluginsDir, "qa-watcher", "server.js");
      fs.mkdirSync(path.dirname(server), { recursive: true });
      fs.writeFileSync(server, "export default () => ({});\n");
      watcher.startWatchers(callbacks());

      // The edit is inside the poll because chokidar's first scan finishes on its
      // own schedule, and an edit made before it does is one nobody was watching
      // for. Editing until the gateway notices removes that race without hiding
      // the failure this case exists for: a watch that cannot see the file never
      // notices, however many times it is written. The interval is longer than
      // the watcher's debounce, which collapses a burst — editing faster than
      // that would keep pushing the rescan it is waiting for out of reach.
      await vi.waitFor(
        () => {
          fs.appendFileSync(server, "// edited\n");
          expect(changes).toHaveBeenCalled();
        },
        { timeout: OBSERVE_MS, interval: EDIT_INTERVAL_MS },
      );
    },
    CASE_TIMEOUT_MS,
  );
});

describe("isUnwatchedPluginPath", () => {
  it("skips what a plugin carries but does not consist of", () => {
    const plugin = path.join(pluginsDir, "qa-watcher");

    expect(watcher.isUnwatchedPluginPath(path.join(plugin, "server.js"))).toBe(false);
    expect(watcher.isUnwatchedPluginPath(path.join(plugin, "dist", "server.js"))).toBe(false);
    expect(watcher.isUnwatchedPluginPath(path.join(plugin, "node_modules", "dep", "index.js"))).toBe(true);
    expect(watcher.isUnwatchedPluginPath(path.join(plugin, ".git", "HEAD"))).toBe(true);
    // The root the whole watch hangs off.
    expect(watcher.isUnwatchedPluginPath(pluginsDir)).toBe(false);
  });
});
