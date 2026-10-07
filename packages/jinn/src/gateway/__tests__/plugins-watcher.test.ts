import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Listener = () => void;

interface WatcherDouble {
  close: ReturnType<typeof vi.fn>;
  emit: (event: string) => void;
  on: (event: string, listener: Listener) => WatcherDouble;
}

const chokidar = vi.hoisted(() => {
  const watchers: WatcherDouble[] = [];
  const watch = vi.fn((watchPath: string) => {
    if (!fs.existsSync(watchPath)) throw new Error(`Cannot watch missing path: ${watchPath}`);
    const listeners = new Map<string, Listener[]>();
    const watcher: WatcherDouble = {
      close: vi.fn(async () => {}),
      emit(event) {
        for (const listener of listeners.get(event) ?? []) listener();
      },
      on(event, listener) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return watcher;
      },
    };
    watchers.push(watcher);
    return watcher;
  });

  return { watch, watchers };
});

vi.mock("chokidar", () => ({ watch: chokidar.watch }));

// JINN_HOME has to be set before anything reaches paths.js, which reads it once.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-plugins-watcher-"));
process.env.JINN_HOME = tmpHome;
const pluginsDir = path.join(tmpHome, "plugins");
const DEBOUNCE_MS = 500;

type Watcher = typeof import("../watcher.js");
let watcher: Watcher;
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

function startWatching(): void {
  watcher.startWatchers(callbacks());
}

function pluginsWatcher(): WatcherDouble {
  return chokidar.watchers.at(-1)!;
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
  vi.useFakeTimers();
  chokidar.watch.mockClear();
  chokidar.watchers.length = 0;
  fs.rmSync(pluginsDir, { recursive: true, force: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  changes.mockClear();
});

afterEach(async () => {
  await watcher.stopWatchers();
  vi.useRealTimers();
});

describe("debounce", () => {
  it("collapses a burst into one call", () => {
    const fired = vi.fn();
    const debounced = watcher.debounce(fired, 50);
    debounced();
    debounced();
    debounced();

    vi.advanceTimersByTime(50);

    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("cancel disarms a pending call", () => {
    const fired = vi.fn();
    const debounced = watcher.debounce(fired, 50);
    debounced();
    debounced.cancel();

    vi.advanceTimersByTime(50);

    expect(fired).not.toHaveBeenCalled();
  });
});

describe("the plugins watcher", () => {
  it("finishes starting when the plugins directory does not exist", () => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });

    expect(watcher.startWatchers(callbacks())).toBeUndefined();
    expect(fs.existsSync(pluginsDir)).toBe(true);
  });

  it("rescans when a plugin directory is removed", () => {
    const pluginDir = path.join(pluginsDir, "alpha");
    fs.mkdirSync(pluginDir);
    watcher.startWatchers(callbacks());
    fs.rmSync(pluginDir, { recursive: true, force: true });
    pluginsWatcher().emit("all");

    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("rescans once per debounce window however many directories land in it", () => {
    startWatching();
    pluginsWatcher().emit("all");
    pluginsWatcher().emit("all");

    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("fires no rescan after shutdown, even for a change that landed inside the window", async () => {
    startWatching();
    pluginsWatcher().emit("all");

    await watcher.stopWatchers();
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(changes).not.toHaveBeenCalled();
  });
});
