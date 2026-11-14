import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { call, callThroughAuthGate, install, resetPlugins, startHarness, writeConfig } from "./plugins-api-harness.js";

/**
 * The two properties the backend mount exists to hold: an unauthenticated caller
 * cannot read installed-versus-not off the status code, and a plugin that fails
 * fails alone. The mount's ordinary routing lives in plugins-backend.test.ts.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let onConfigReload: () => void;
let reconcileWatchers: () => Promise<void>;

function installBackend(id: string, source: string): void {
  install(id, { id, name: id, version: "1.0.0", server: "server.js" }, { "server.js": source });
}

const HEALTHY = `export default () => ({
  "GET /ping": (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); },
});`;

beforeAll(async () => {
  ({ onConfigReload, reconcileWatchers } = await startHarness());
});

/**
 * `onConfigReload` starts a watcher reconcile it does not wait for, and that
 * pass loads plugin modules from disk. A case that then rewrites a plugin's
 * `server.js` is racing it: the pass stats the old file, imports after the
 * write, and the module evaluates once for the pass and once more for the
 * request, under two different version keys. So every setup here settles its
 * own pass before the case starts writing.
 */
beforeEach(async () => {
  vi.clearAllMocks();
  resetPlugins();
  writeConfig({ enabled: ["inbox"] });
  onConfigReload();
  await reconcileWatchers();
});

describe("the enable gate never answers before auth does", () => {
  // Walking /api/plugins/<guess>/ would otherwise let anyone who can reach the
  // port read the operator's installed plugins off 404-versus-something-else.
  beforeEach(async () => {
    installBackend("inbox", HEALTHY);
    writeConfig({ enabled: ["inbox"] }, { authRequired: true });
    onConfigReload();
    await reconcileWatchers();
  });

  it("answers an enabled plugin and a not-installed id identically to an unauthenticated caller", async () => {
    const enabled = await callThroughAuthGate("GET", "/api/plugins/inbox/ping");
    const absent = await callThroughAuthGate("GET", "/api/plugins/not-installed/ping");

    expect(enabled.status).toBe(401);
    expect(absent.status).toBe(401);
    expect(enabled.bodyText).toBe(absent.bodyText);
  });

  it("still tells the two apart once the caller authenticates, so the 401s were the gate and not the answer", async () => {
    const enabled = await callThroughAuthGate("GET", "/api/plugins/inbox/ping", { authorization: "Bearer test-token" });
    const absent = await callThroughAuthGate("GET", "/api/plugins/not-installed/ping", {
      authorization: "Bearer test-token",
    });

    expect(enabled.status).toBe(200);
    expect(absent.status).toBe(404);
  });
});

describe("a plugin that fails, fails alone", () => {
  beforeEach(async () => {
    installBackend("healthy", HEALTHY);
    writeConfig({ enabled: ["healthy", "broken"] });
    onConfigReload();
    await reconcileWatchers();
  });

  it.each([
    ["a registrar that throws on import", `throw new Error("kaboom from the plugin");`, "failed to load"],
    [
      "a module that default-exports something other than a function",
      `export default { "GET /ping": 1 };`,
      "failed to load",
    ],
    [
      "a registrar that returns no routes",
      `export default () => undefined;`,
      "failed to load",
    ],
    [
      "a handler that throws synchronously",
      `export default () => ({ "GET /ping": () => { throw new Error("kaboom from the handler"); } });`,
      "failed to handle the request",
    ],
    [
      "a handler that returns a rejected promise",
      `export default () => ({ "GET /ping": async () => { throw new Error("kaboom, eventually"); } });`,
      "failed to handle the request",
    ],
  ])("500s %s for that request only", async (_case, source, wording) => {
    installBackend("broken", source);

    const failed = await call("GET", "/api/plugins/broken/ping");
    expect(failed.status).toBe(500);
    // The gateway's own wording. A third party's error text and stack stay in the
    // log; putting them on the wire hands a caller the plugin's internals.
    expect(failed.body).toEqual({ error: `plugin "broken" ${wording}` });
    expect(failed.bodyText).not.toContain("kaboom");

    // The process is still serving, and the plugin beside it is untouched.
    const healthy = await call("GET", "/api/plugins/healthy/ping");
    expect(healthy.status).toBe(200);
    expect(healthy.body).toEqual({ ok: true });
  });

  it("does not re-import a broken plugin on every request", async () => {
    const { logger } = await import("../../shared/logger.js");
    installBackend("broken", `globalThis.__brokenImports = (globalThis.__brokenImports ?? 0) + 1;
      throw new Error("kaboom from the plugin");`);

    for (let i = 0; i < 3; i++) expect((await call("GET", "/api/plugins/broken/ping")).status).toBe(500);

    expect((globalThis as { __brokenImports?: number }).__brokenImports).toBe(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("leaves the response a plugin already wrote alone when it throws afterwards", async () => {
    installBackend(
      "broken",
      `export default () => ({
        "GET /ping": (req, res) => {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end('{"partial":true}');
          throw new Error("kaboom after writing");
        },
      });`,
    );

    // Answering 500 here would mean a second writeHead, which Node refuses — out
    // of the only error boundary api.ts has, taking the request down twice over.
    const failed = await call("GET", "/api/plugins/broken/ping");
    expect(failed.status).toBe(202);
    expect(failed.bodyText).toContain("partial");

    expect((await call("GET", "/api/plugins/healthy/ping")).status).toBe(200);
  });
});
