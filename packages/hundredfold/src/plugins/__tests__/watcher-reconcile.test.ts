import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedBackend, PluginServerContext, PluginWatcher } from "../backend.js";
import {
  pluginWatcherHealth,
  reconcilePluginWatchers,
  stopAllPluginWatchers,
} from "../watcher-supervisor.js";

/**
 * Reconciling against a plugin whose module never finishes importing, which is
 * where shutdown and boot can overlap: importing third-party code is the one slow
 * step in a pass, and the gateway does not wait on it.
 */
const loadPluginBackend = vi.hoisted(() => vi.fn());

vi.mock("../backend.js", () => ({
  loadPluginBackend,
  pluginSettings: () => ({}),
}));

vi.mock("../discovery.js", () => ({
  loadPlugin: (id: string) => Promise.resolve({ id, status: "loaded", server: `/plugins/${id}/server.js` }),
}));

const context = { id: "probe" } as unknown as PluginServerContext;

/** Health outlives a stop, so each case reconciles its own plugin id. */
let counter = 0;
function freshId(): string {
  return `slow-import-${counter++}`;
}

/** A watcher that records its calls, and a `loadPluginBackend` that hands it over
 *  only when the case says so. */
function deferredBackend() {
  const calls = { started: 0, stopped: 0 };
  const watcher: PluginWatcher = {
    start: () => void calls.started++,
    stop: () => void calls.stopped++,
  };
  let finishImport!: () => void;
  const importing = new Promise<LoadedBackend>((resolve) => {
    finishImport = () => resolve({ version: "1", routes: {}, watcher, context });
  });
  loadPluginBackend.mockReturnValue(importing);
  return { calls, finishImport };
}

/** The operator's list, naming the one plugin a case reconciles. */
function configFor(id: string) {
  return { plugins: { enabled: [id] } };
}

/** The pass is mid-import once the plugin's module has been asked for. */
async function untilImporting(): Promise<void> {
  await vi.waitFor(() => expect(loadPluginBackend).toHaveBeenCalled());
}

beforeEach(() => {
  loadPluginBackend.mockReset();
});

afterEach(async () => {
  await stopAllPluginWatchers();
});

describe("reconcilePluginWatchers", () => {
  it("starts the watcher the import produces", async () => {
    const id = freshId();
    const { calls, finishImport } = deferredBackend();

    const reconciling = reconcilePluginWatchers(() => configFor(id));
    await untilImporting();
    finishImport();
    await reconciling;

    expect(calls.started).toBe(1);
    expect(pluginWatcherHealth(id)).toEqual({ status: "running", restarts: 0 });
  });

  it("starts nothing when the gateway shuts down while the import is in flight", async () => {
    const id = freshId();
    const { calls, finishImport } = deferredBackend();

    const reconciling = reconcilePluginWatchers(() => configFor(id));
    await untilImporting();
    await stopAllPluginWatchers();
    finishImport();
    await reconciling;

    // Not started and then stopped: never started. A watcher that begins after
    // shutdown holds whatever it opened for the rest of the process' life, and
    // nothing is left to stop it.
    expect(calls.started).toBe(0);
    expect(calls.stopped).toBe(0);
    expect(pluginWatcherHealth(id)).toBeNull();
  });

  it("starts nothing when a reconcile queued behind the import outlives the shutdown", async () => {
    const id = freshId();
    const { calls, finishImport } = deferredBackend();

    const reconciling = reconcilePluginWatchers(() => configFor(id));
    await untilImporting();
    // A config reload arriving mid-import is queued behind the pass in flight,
    // and shutdown lands before either of them gets to the plugin.
    const queued = reconcilePluginWatchers(() => configFor(id));
    await stopAllPluginWatchers();
    finishImport();
    await Promise.all([reconciling, queued]);

    expect(calls.started).toBe(0);
    expect(calls.stopped).toBe(0);
    expect(pluginWatcherHealth(id)).toBeNull();
  });
});
