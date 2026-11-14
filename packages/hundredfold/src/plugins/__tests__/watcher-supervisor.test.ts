import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginServerContext, PluginWatcher } from "../backend.js";
import {
  pluginWatcherHealth,
  startPluginWatcher,
  stopAllPluginWatchers,
  stopPluginWatcher,
  WATCHER_MAX_RESTARTS,
  WATCHER_RESTART_BASE_MS,
  WATCHER_STOP_TIMEOUT_MS,
} from "../watcher-supervisor.js";

const context = { id: "probe" } as unknown as PluginServerContext;

let counter = 0;
function freshId(): string {
  return `watched-${counter++}`;
}

/** A watcher that records its calls, and fails on demand. */
function spyWatcher(overrides: Partial<PluginWatcher> = {}) {
  const calls = { started: 0, stopped: 0 };
  const watcher: PluginWatcher = {
    start(ctx) {
      calls.started++;
      return overrides.start?.(ctx);
    },
    stop() {
      calls.stopped++;
      return overrides.stop?.();
    },
  };
  return { watcher, calls };
}

/** Rejections the supervisor is expected to absorb, counted rather than argued
 *  about: an unhandled one here is the gateway top level, which is what AC3
 *  forbids. */
function watchTopLevel() {
  const escaped: unknown[] = [];
  const onUnhandled = (reason: unknown) => escaped.push(reason);
  process.on("unhandledRejection", onUnhandled);
  process.on("uncaughtException", onUnhandled);
  return {
    escaped,
    async settle() {
      // Two macrotask turns: Node reports an unhandled rejection at the end of
      // the turn the promise was rejected in, not synchronously.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      process.off("unhandledRejection", onUnhandled);
      process.off("uncaughtException", onUnhandled);
      return escaped;
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await stopAllPluginWatchers();
});

describe("startPluginWatcher", () => {
  it("starts a watcher once and reports it running", async () => {
    const id = freshId();
    const { watcher, calls } = spyWatcher();

    await startPluginWatcher(id, { version: "1", watcher, context });

    expect(calls.started).toBe(1);
    expect(pluginWatcherHealth(id)).toEqual({ status: "running", restarts: 0 });
  });

  it("does not start the same incarnation twice", async () => {
    const id = freshId();
    const { watcher, calls } = spyWatcher();

    await startPluginWatcher(id, { version: "1", watcher, context });
    await startPluginWatcher(id, { version: "1", watcher, context });

    expect(calls.started).toBe(1);
    expect(calls.stopped).toBe(0);
  });

  it("stops the old incarnation before starting the edited one", async () => {
    const id = freshId();
    const order: string[] = [];
    const old = spyWatcher({ stop: () => void order.push("old stop") });
    const edited = spyWatcher({ start: () => void order.push("new start") });

    await startPluginWatcher(id, { version: "1", watcher: old.watcher, context });
    await startPluginWatcher(id, { version: "2", watcher: edited.watcher, context });

    expect(order).toEqual(["old stop", "new start"]);
    expect(old.calls.stopped).toBe(1);
    expect(edited.calls.started).toBe(1);
  });

  it("reports no watcher state for a plugin the supervisor does not hold", () => {
    expect(pluginWatcherHealth(freshId())).toBeNull();
  });
});

describe("stopPluginWatcher", () => {
  it("stops a running watcher and keeps reporting it stopped", async () => {
    const id = freshId();
    const { watcher, calls } = spyWatcher();
    await startPluginWatcher(id, { version: "1", watcher, context });

    await stopPluginWatcher(id);

    expect(calls.stopped).toBe(1);
    // Not null: a watcher the operator turned off is a state to show, and the
    // plugin that never had one is the case null belongs to.
    expect(pluginWatcherHealth(id)).toEqual({ status: "stopped", restarts: 0 });
  });

  it("reports a restarted watcher's count once it is stopped", async () => {
    vi.useFakeTimers();
    const id = freshId();
    let attempts = 0;
    const { watcher } = spyWatcher({
      start: () => {
        attempts++;
        if (attempts === 1) throw new Error("broken once");
      },
    });
    await startPluginWatcher(id, { version: "1", watcher, context });
    await vi.advanceTimersByTimeAsync(WATCHER_RESTART_BASE_MS);

    await stopPluginWatcher(id);

    expect(pluginWatcherHealth(id)).toEqual({ status: "stopped", restarts: 1 });
  });

  it("abandons a stop() that never resolves instead of blocking shutdown", async () => {
    vi.useFakeTimers();
    const id = freshId();
    const { watcher } = spyWatcher({ stop: () => new Promise<void>(() => {}) });
    await startPluginWatcher(id, { version: "1", watcher, context });

    let returned = false;
    const stopping = stopPluginWatcher(id).then(() => {
      returned = true;
    });
    await vi.advanceTimersByTimeAsync(WATCHER_STOP_TIMEOUT_MS - 1);
    expect(returned).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(returned).toBe(true);
  });

  it("absorbs a stop() that throws", async () => {
    const top = watchTopLevel();
    const id = freshId();
    const { watcher } = spyWatcher({
      stop: () => Promise.reject(new Error("stop blew up")),
    });
    await startPluginWatcher(id, { version: "1", watcher, context });

    await expect(stopPluginWatcher(id)).resolves.toBeUndefined();
    expect(await top.settle()).toEqual([]);
  });
});

describe("crash handling", () => {
  it("restarts a start() that throws, with exponential backoff", async () => {
    vi.useFakeTimers();
    const id = freshId();
    let attempts = 0;
    const { watcher } = spyWatcher({
      start: () => {
        attempts++;
        if (attempts <= 2) throw new Error("cannot open the folder");
      },
    });

    await startPluginWatcher(id, { version: "1", watcher, context });
    expect(attempts).toBe(1);
    expect(pluginWatcherHealth(id)?.status).toBe("error");

    await vi.advanceTimersByTimeAsync(WATCHER_RESTART_BASE_MS);
    expect(attempts).toBe(2);
    // The second wait is twice the first, so a shorter advance changes nothing.
    await vi.advanceTimersByTimeAsync(WATCHER_RESTART_BASE_MS);
    expect(attempts).toBe(2);

    await vi.advanceTimersByTimeAsync(WATCHER_RESTART_BASE_MS);
    expect(attempts).toBe(3);
    expect(pluginWatcherHealth(id)).toEqual({ status: "running", restarts: 2 });
  });

  it("restarts a watcher that fails long after it started", async () => {
    vi.useFakeTimers();
    const id = freshId();
    let attempts = 0;
    let fail: ((err: Error) => void) | undefined;
    const { watcher } = spyWatcher({
      start: () => {
        attempts++;
        return new Promise<void>((_resolve, reject) => {
          fail = reject;
        });
      },
    });

    await startPluginWatcher(id, { version: "1", watcher, context });
    expect(pluginWatcherHealth(id)?.status).toBe("running");

    fail?.(new Error("the folder went away"));
    await vi.advanceTimersByTimeAsync(0);
    expect(pluginWatcherHealth(id)?.status).toBe("error");
    expect(pluginWatcherHealth(id)?.detail).toContain("the folder went away");

    await vi.advanceTimersByTimeAsync(WATCHER_RESTART_BASE_MS);
    expect(attempts).toBe(2);
  });

  it("stays down and says so once the backoff cap is spent", async () => {
    vi.useFakeTimers();
    const id = freshId();
    let attempts = 0;
    const { watcher } = spyWatcher({
      start: () => {
        attempts++;
        throw new Error("always broken");
      },
    });

    await startPluginWatcher(id, { version: "1", watcher, context });
    // Far past the last backoff, so nothing is merely still pending.
    await vi.advanceTimersByTimeAsync(WATCHER_RESTART_BASE_MS * 2 ** (WATCHER_MAX_RESTARTS + 2));

    expect(attempts).toBe(WATCHER_MAX_RESTARTS + 1);
    const health = pluginWatcherHealth(id);
    expect(health?.status).toBe("error");
    expect(health?.restarts).toBe(WATCHER_MAX_RESTARTS);
    expect(health?.detail).toContain("always broken");
    expect(health?.detail).toMatch(/stayed down/);
  });

  it("lets no watcher failure reach the gateway's top level", async () => {
    const top = watchTopLevel();
    const thrower = spyWatcher({
      start: () => {
        throw new Error("sync boom");
      },
    });
    const rejecter = spyWatcher({ start: () => Promise.reject(new Error("async boom")) });

    await startPluginWatcher(freshId(), { version: "1", watcher: thrower.watcher, context });
    await startPluginWatcher(freshId(), { version: "1", watcher: rejecter.watcher, context });

    expect(await top.settle()).toEqual([]);
  });

  it("does not restart a watcher that was stopped while waiting to retry", async () => {
    vi.useFakeTimers();
    const id = freshId();
    let attempts = 0;
    const { watcher } = spyWatcher({
      start: () => {
        attempts++;
        throw new Error("broken");
      },
    });

    await startPluginWatcher(id, { version: "1", watcher, context });
    await stopPluginWatcher(id);
    await vi.advanceTimersByTimeAsync(WATCHER_RESTART_BASE_MS * 8);

    expect(attempts).toBe(1);
  });
});

describe("stopAllPluginWatchers", () => {
  it("stops every supervised watcher", async () => {
    const first = spyWatcher();
    const second = spyWatcher();
    const firstId = freshId();
    const secondId = freshId();
    await startPluginWatcher(firstId, { version: "1", watcher: first.watcher, context });
    await startPluginWatcher(secondId, { version: "1", watcher: second.watcher, context });

    await stopAllPluginWatchers();

    expect(first.calls.stopped).toBe(1);
    expect(second.calls.stopped).toBe(1);
    expect(pluginWatcherHealth(firstId)).toEqual({ status: "stopped", restarts: 0 });
    expect(pluginWatcherHealth(secondId)).toEqual({ status: "stopped", restarts: 0 });
  });
});
