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
  it("starts with no projects directory, then reports the change when the directory and a file appear", async () => {
    expect(fs.existsSync(path.join(tmp, "projects"))).toBe(false);
    const onProjectsChange = vi.fn();
    const callbacks: Callbacks = {
      onConfigReload: noop, onCronReload: noop, onOrgChange: noop, onSkillsChange: noop, onPluginsChange: noop, onProjectsChange,
    };
    watcher.startWatchers(callbacks);
    expect(registry.readProjects().projects).toEqual([]);
    expect(onProjectsChange).not.toHaveBeenCalled();

    fs.mkdirSync(path.join(tmp, "projects"));
    fs.writeFileSync(projectFile, "id: prj_0a1b2c3d4e5f\nname: Garden Planner\n");
    await vi.waitFor(() => expect(onProjectsChange).toHaveBeenCalled(), { timeout: 8000, interval: 100 });
    expect(registry.refreshProjects().projects.map((p) => p.name)).toEqual(["Garden Planner"]);
  }, 15_000);

  it("loads definitions that already exist when the watchers start", async () => {
    await watcher.stopWatchers();
    registry.resetProjectRegistryForTests();
    const callbacks: Callbacks = {
      onConfigReload: noop, onCronReload: noop, onOrgChange: noop, onSkillsChange: noop, onPluginsChange: noop, onProjectsChange: noop,
    };
    watcher.startWatchers(callbacks);
    expect(registry.readProjects().byId.get("prj_0a1b2c3d4e5f")?.name).toBe("Garden Planner");
  });
});
