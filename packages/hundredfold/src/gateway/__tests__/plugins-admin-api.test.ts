import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  call,
  callThroughAuthGate,
  configPath,
  install,
  pluginsDir,
  reloadConfigOnly,
  resetPlugins,
  startHarness,
  writeConfig,
} from "./plugins-api-harness.js";

/**
 * The operator's half of the plugin API: the enable decision written to
 * `config.yaml`, the folder reveal, and the rescan that has to be a rescan.
 *
 * `spawn` is the only thing doubled. Everything else is the real gateway against
 * a private instance home, because what these cases are about is what actually
 * lands on disk and in the supervisor.
 */

interface SpawnedChild {
  on: (event: string, listener: (err: Error) => void) => SpawnedChild;
  unref: () => void;
}

const spawned = vi.hoisted(() => vi.fn<(bin: string, args: string[], options: unknown) => SpawnedChild>());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawned };
});

/** A watcher that records its own lifecycle where a cache-busting re-import
 *  cannot lose it. */
const WATCHER_SERVER_JS = `
const seen = (globalThis.__inboxWatcher ??= { started: 0, stopped: 0 });
export const watcher = {
  start() { seen.started++; },
  stop() { seen.stopped++; },
};
export default () => ({});
`;

let onConfigReload: () => void;
let reconcileWatchers: () => Promise<void>;
let pluginWatcherHealth: (id: string) => { status: string } | null;
let asSession: (sessionId: string) => Record<string, string>;
let newSession: () => string;

function savedConfig(): { plugins?: { enabled?: string[]; disabled?: string[] } } {
  return yaml.load(fs.readFileSync(configPath, "utf-8")) as { plugins?: { enabled?: string[]; disabled?: string[] } };
}

function statusOf(inventory: { id: string; status: string }[], id: string): string | undefined {
  return inventory.find((row) => row.id === id)?.status;
}

beforeAll(async () => {
  ({ onConfigReload, reconcileWatchers } = await startHarness());
  ({ pluginWatcherHealth } = await import("../../plugins/watcher-supervisor.js"));

  const registry = await import("../../sessions/registry.js");
  const { ensureSessionCapability } = await import("../../mcp/identity.js");
  newSession = () => registry.createSession({ engine: "codex", source: "web", sourceRef: "plugins-admin" }).id;
  asSession = (sessionId) => ({
    "x-hundredfold-tool-call": "hundredfold-mcp",
    "x-hundredfold-caller-session": sessionId,
    "x-hundredfold-session-capability": ensureSessionCapability(sessionId)!,
  });
});

beforeEach(async () => {
  resetPlugins();
  writeConfig({ enabled: [] });
  onConfigReload();
  await reconcileWatchers();
  spawned.mockReset();
  spawned.mockImplementation(() => ({ on: () => spawned.mock.results[0]!.value as SpawnedChild, unref: () => {} }));
  delete (globalThis as { __inboxWatcher?: unknown }).__inboxWatcher;
  install("inbox", { id: "inbox", name: "Inbox", version: "2.0.0", server: "server.js" }, {
    "server.js": WATCHER_SERVER_JS,
  });
});

describe("the operator's two lists", () => {
  it("enabling adds the id to enabled and takes it out of disabled", async () => {
    writeConfig({ enabled: [], disabled: ["inbox", "other"] });
    reloadConfigOnly();

    const answer = await call("POST", "/api/plugins/inbox/enabled", {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    }, { enabled: true });

    expect(answer.status).toBe(200);
    expect(savedConfig().plugins).toMatchObject({ enabled: ["inbox"], disabled: ["other"] });
  });

  it("disabling adds the id to disabled and takes it out of enabled", async () => {
    writeConfig({ enabled: ["inbox", "other"], disabled: [] });
    reloadConfigOnly();

    await call("POST", "/api/plugins/inbox/enabled", { authorization: "Bearer test-token" }, { enabled: false });

    expect(savedConfig().plugins).toMatchObject({ enabled: ["other"], disabled: ["inbox"] });
  });

  it("the write reaches the next GET /api/plugins, both ways", async () => {
    await call("POST", "/api/plugins/inbox/enabled", { authorization: "Bearer test-token" }, { enabled: true });
    expect(statusOf((await call("GET", "/api/plugins")).body.inventory, "inbox")).toBe("loaded");

    await call("POST", "/api/plugins/inbox/enabled", { authorization: "Bearer test-token" }, { enabled: false });
    expect(statusOf((await call("GET", "/api/plugins")).body.inventory, "inbox")).toBe("disabled");
  });

  it("leaves the operator's unrelated config alone", async () => {
    await call("POST", "/api/plugins/inbox/enabled", { authorization: "Bearer test-token" }, { enabled: true });

    const saved = yaml.load(fs.readFileSync(configPath, "utf-8")) as { engines?: { default?: string } };
    expect(saved.engines?.default).toBe("codex");
  });

  // The toggle and the Settings page write the same file; a later save must not be what rejects the toggle's key.
  it("survives the Settings page saving back the config it was served", async () => {
    await call("POST", "/api/plugins/inbox/enabled", { authorization: "Bearer test-token" }, { enabled: true });

    const fetched = await call("GET", "/api/config", { authorization: "Bearer test-token" });
    expect(fetched.status).toBe(200);

    const saved = await call("PUT", "/api/config", { authorization: "Bearer test-token" }, fetched.body);
    expect(saved.status).toBe(200);
    expect(savedConfig().plugins?.enabled).toContain("inbox");
  });

  it("refuses a body that does not decide anything", async () => {
    const answer = await call("POST", "/api/plugins/inbox/enabled", { authorization: "Bearer test-token" }, { enabled: "yes" });

    expect(answer.status).toBe(400);
    expect(savedConfig().plugins?.enabled ?? []).not.toContain("inbox");
  });

  it("refuses to decide about a plugin that is not installed", async () => {
    const answer = await call("POST", "/api/plugins/ghost/enabled", { authorization: "Bearer test-token" }, { enabled: true });

    expect(answer.status).toBe(404);
    expect(savedConfig().plugins?.enabled ?? []).not.toContain("ghost");
  });
});

describe("operator authority", () => {
  it("refuses a session-authority caller on both routes", async () => {
    const session = newSession();

    for (const route of ["/api/plugins/inbox/enabled", "/api/plugins/inbox/reveal"]) {
      const answer = await call("POST", route, asSession(session), { enabled: true });
      expect(answer.status).toBe(403);
      expect(answer.body.error).toContain("operator-only");
    }
    expect(spawned).not.toHaveBeenCalled();
    expect(savedConfig().plugins?.enabled ?? []).not.toContain("inbox");
  });

  it("stops an unauthenticated caller at the auth gate, before either handler runs", async () => {
    writeConfig({ enabled: [] }, { authRequired: true });
    reloadConfigOnly();

    for (const route of ["/api/plugins/inbox/enabled", "/api/plugins/inbox/reveal"]) {
      expect((await callThroughAuthGate("POST", route)).status).toBe(401);
    }
    expect(spawned).not.toHaveBeenCalled();
    expect(savedConfig().plugins?.enabled ?? []).not.toContain("inbox");
  });
});

describe("reveal", () => {
  it("hands the file manager the installed directory, with stdio explicit", async () => {
    const answer = await call("POST", "/api/plugins/inbox/reveal", { authorization: "Bearer test-token" });

    expect(answer.status).toBe(200);
    const [, args, options] = spawned.mock.calls[0]!;
    // `.native` to match the async `fs.realpath` the route resolves through: on Windows that
    // expands an 8.3 short name (`RUNNER~1` -> `runneradmin`) and the JS `realpathSync` does not.
    expect(args).toEqual([fs.realpathSync.native(path.join(pluginsDir, "inbox"))]);
    expect(options).toMatchObject({ stdio: "ignore" });
  });

  it("never takes a directory from the caller", async () => {
    // Both spellings a caller could reach for: one that is not a plugin id at
    // all, and one shaped like a traversal out of the plugins directory.
    for (const id of ["..", "not%2Fan%2Fid"]) {
      expect((await call("POST", `/api/plugins/${id}/reveal`, { authorization: "Bearer test-token" })).status).toBe(404);
    }
    expect((await call("POST", "/api/plugins/ghost/reveal", { authorization: "Bearer test-token" })).status).toBe(404);
    expect(spawned).not.toHaveBeenCalled();
  });
});

describe("rescan", () => {
  it("stops the watcher of a plugin that is no longer enabled", async () => {
    writeConfig({ enabled: ["inbox"] });
    onConfigReload();
    await reconcileWatchers();
    expect(pluginWatcherHealth("inbox")?.status).toBe("running");

    // config.yaml has moved on, but nothing has reconciled the runtime built
    // from the old one — the state the rescan button exists for.
    writeConfig({ enabled: [] });
    reloadConfigOnly();
    expect(pluginWatcherHealth("inbox")?.status).toBe("running");

    const answer = await call("POST", "/api/plugins/rescan", { authorization: "Bearer test-token" });

    expect(answer.status).toBe(200);
    expect(pluginWatcherHealth("inbox")?.status).not.toBe("running");
    expect((globalThis as { __inboxWatcher?: { stopped: number } }).__inboxWatcher?.stopped).toBe(1);
  });
});
