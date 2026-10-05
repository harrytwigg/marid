import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The projects/ watcher: it loads definitions at boot, tolerates a missing directory, and picks the directory up when it appears. */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-projects-watcher-"));
process.env.JINN_HOME = tmp;

type Watcher = typeof import("../watcher.js");
type Callbacks = Parameters<Watcher["startWatchers"]>[0];
let watcher: Watcher;
let registry: typeof import("../project-registry.js");

const noop = () => {};
const projectFile = path.join(tmp, "projects", "garden-planner.yaml");

beforeAll(async () => {
  watcher = await import("../watcher.js");
  registry = await import("../project-registry.js");
});

afterAll(async () => {
  await watcher.stopWatchers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the projects watcher", () => {
  const callbacksWith = (onProjectsChange: () => void): Callbacks => ({
    onConfigReload: noop, onCronReload: noop, onOrgChange: noop, onSkillsChange: noop, onPluginsChange: noop, onProjectsChange,
  });

  it("starts with no projects directory: an empty set, and no change reported", async () => {
    expect(fs.existsSync(path.join(tmp, "projects"))).toBe(false);
    const onProjectsChange = vi.fn();
    watcher.startWatchers(callbacksWith(onProjectsChange));
    await watcher.projectsWatcherReady();
    expect(registry.readProjects().projects).toEqual([]);
    expect(onProjectsChange).not.toHaveBeenCalled();
    await watcher.stopWatchers();
  });

  // On macOS a write made in the first moments after a watch attaches can be dropped, even once
  // chokidar has said ready (the raw event stream stays silent). Nothing real edits a project file
  // that fast, so the test writes again on each poll, slower than the watcher's write-settle window,
  // until the watcher reports it, instead of guessing how long attaching takes.
  it("reports a file written into the directory once the watcher is ready", async () => {
    fs.mkdirSync(path.join(tmp, "projects"));
    const onProjectsChange = vi.fn();
    watcher.startWatchers(callbacksWith(onProjectsChange));
    await watcher.projectsWatcherReady();

    let writes = 0;
    await vi.waitFor(() => {
      fs.writeFileSync(projectFile, `id: prj_0a1b2c3d4e5f\nname: Garden Planner\n# write ${writes++}\n`);
      expect(onProjectsChange).toHaveBeenCalled();
    }, { timeout: 12_000, interval: 700 });
    expect(registry.refreshProjects().projects.map((p) => p.name)).toEqual(["Garden Planner"]);
  }, 20_000);

  it("loads definitions that already exist when the watchers start", async () => {
    await watcher.stopWatchers();
    registry.resetProjectRegistryForTests();
    watcher.startWatchers(callbacksWith(noop));
    expect(registry.readProjects().byId.get("prj_0a1b2c3d4e5f")?.name).toBe("Garden Planner");
  });
});
