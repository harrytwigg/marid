import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineLimitEngineSnapshot, JinnConfig } from "../../shared/types.js";
import type { IdleCapacityConfig } from "../../shared/idle-capacity-config.js";
import type { WorkItem } from "../../work-items/store.js";
import type { StartTodoDispatcherResult } from "../todo-dispatch.js";

/**
 * The fixture the idle-capacity loop tests share: a throwaway
 * JINN_HOME, a real work-item store, and a loop whose collector, clock,
 * dispatch and operator signals are all injected.
 *
 * JINN_HOME is set as this module is evaluated, so a test file must import
 * it before anything that reads the home.
 */

export const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-idle-capacity-"));
process.env.JINN_HOME = home;

export type Loop = typeof import("../idle-capacity.js");
export type Store = typeof import("../../work-items/store.js");

export const modules = {} as {
  loop: Loop;
  store: Store;
  labels: typeof import("../../work-items/labels.js");
  dispatchConfig: typeof import("../../work-items/dispatch-config.js");
  stopCause: typeof import("../../work-items/stop-cause.js");
  comments: typeof import("../../work-items/comments.js");
  db: import("better-sqlite3").Database;
};

/** 10:00 UTC on a Sunday: 11:00 in Europe/London, squarely daytime. */
export const NOW = Date.parse("2026-09-20T10:00:00Z");
/** 03:00 London the same night. */
export const NIGHT = Date.parse("2026-09-20T02:00:00Z");
export const minutes = (n: number, from = NOW): number => Math.floor((from + n * 60_000) / 1000);

export function config(idleCapacity: IdleCapacityConfig | undefined): JinnConfig {
  return {
    // `process.execPath` is an executable that exists, so "Claude is installed"
    // is true without depending on the host's PATH.
    gateway: { port: 7799, host: "127.0.0.1", ...(idleCapacity ? { idleCapacity } : {}) },
    engines: { default: "claude", claude: { bin: process.execPath, model: "opus" }, opencode: { bin: process.execPath, model: "x" } },
    models: { claude: { default: "opus", models: [{ id: "opus" }] }, opencode: { default: "x", models: [{ id: "x" }] } },
    connectors: {},
    logging: { file: false, stdout: false, level: "error" },
  } as unknown as JinnConfig;
}

export function snapshot(windows: EngineLimitEngineSnapshot["windows"], from = NOW): EngineLimitEngineSnapshot {
  return { name: "claude", available: true, status: "live", source: "test", refreshedAt: new Date(from).toISOString(), models: [], windows };
}

export const week = (from = NOW) => ({ name: "7d", usedPercent: 30, resetsAt: minutes(2 * 24 * 60, from) });
export const LAPSING = snapshot([{ name: "5h", usedPercent: 15, resetsAt: minutes(40) }, week()]);
export const NOT_LAPSING = snapshot([{ name: "5h", usedPercent: 15, resetsAt: minutes(240) }, week()]);

/** A stand-in for the real start: the Dispatcher it spawns delegates the Todo
 *  on, so the Todo leaves `backlog` and the next tick no longer sees it. */
export function started(item: WorkItem): StartTodoDispatcherResult {
  modules.db.prepare("UPDATE work_items SET status = 'assigned' WHERE id = ?").run(item.id);
  return { ok: true, status: 201, body: { workItemId: item.id, sessionId: `sess-${item.id}`, status: "running", reused: false } };
}

export interface HarnessOptions {
  idleCapacity?: IdleCapacityConfig;
  reading?: EngineLimitEngineSnapshot | (() => EngineLimitEngineSnapshot);
  active?: number | (() => number);
  jinnActiveSince?: (sinceMs: number) => boolean;
  interactiveActivityAt?: () => number | undefined;
  operatorSessionActivityAt?: () => number | undefined;
  dispatch?: (item: WorkItem) => StartTodoDispatcherResult;
  now?: number | (() => number);
}

export interface Harness {
  dispatched: string[];
  loop: import("../idle-capacity.js").IdleCapacityAutoStart;
}

const live: Array<{ stop: () => void }> = [];

/** Open a loop on the shared store; `closeAll` stops every loop a test opened. */
export function open(opts: HarnessOptions = {}): Harness {
  const dispatched: string[] = [];
  const cfg = config("idleCapacity" in opts ? opts.idleCapacity : { enabled: true });
  const call = <T,>(value: T | (() => T)): T => (typeof value === "function" ? (value as () => T)() : value);
  const loop = modules.loop.startIdleCapacityAutoStart({
    getConfig: () => cfg,
    context: {} as never,
    collect: async () => call(opts.reading ?? LAPSING),
    activeSessions: () => call(opts.active ?? 0),
    jinnActiveSince: opts.jinnActiveSince ?? (() => false),
    interactiveActivityAt: opts.interactiveActivityAt ?? (() => undefined),
    operatorSessionActivityAt: opts.operatorSessionActivityAt ?? (() => undefined),
    dispatch: (item) => {
      dispatched.push(item.id);
      return opts.dispatch ? opts.dispatch(item) : started(item);
    },
    now: () => call(opts.now ?? NOW),
  });
  live.push(loop);
  return { dispatched, loop };
}

export function closeAll(): void {
  for (const loop of live.splice(0)) loop.stop();
}

export function backlog(title: string, extra: Partial<Parameters<Store["createWorkItem"]>[0]> = {}): WorkItem {
  return modules.store.createWorkItem({ title, status: "backlog", source: "human", ...extra });
}

export async function loadModules(): Promise<void> {
  modules.loop = await import("../idle-capacity.js");
  modules.store = await import("../../work-items/store.js");
  modules.labels = await import("../../work-items/labels.js");
  modules.dispatchConfig = await import("../../work-items/dispatch-config.js");
  modules.stopCause = await import("../../work-items/stop-cause.js");
  modules.comments = await import("../../work-items/comments.js");
  modules.db = (await import("../../shared/db.js")).initDb();
}

/** Every test starts from an empty board. The claims table is created lazily,
 *  so only tables that exist are cleared. */
export function clearBoard(): void {
  const tables = ["work_item_claims", "work_item_comments", "work_item_labels", "work_item_dispatch", "work_item_auto_start",
    "work_item_stop_cause", "work_item_events", "work_items"];
  const present = new Set(modules.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[]);
  for (const table of tables) if (present.has(table)) modules.db.exec(`DELETE FROM ${table}`);
}
