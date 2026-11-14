import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { call, install, pluginsDir, resetPlugins, startHarness, writeConfig } from "./plugins-api-harness.js";

/**
 * The backend mount: `/api/plugins/<id>/*` answered by the plugin's own
 * `server.js`. Auth ordering, error isolation and storage namespacing live in
 * plugins-backend-isolation.test.ts, which shares this rig.
 */

let onConfigReload: () => void;
let clearPluginStorage: () => void;

/** A registrar answering `GET /ping` with whatever expression `body` evaluates to. */
function pinger(body: string): string {
  return `export default (ctx) => ({
    "GET /ping": (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(${body}));
    },
  });`;
}

function installBackend(id: string, source: string): void {
  install(id, { id, name: id, version: "1.0.0", server: "server.js" }, { "server.js": source });
}

function rewriteServer(id: string, source: string): void {
  fs.writeFileSync(path.join(pluginsDir, id, "server.js"), source);
}

beforeAll(async () => {
  ({ onConfigReload } = await startHarness());
  const { initDb } = await import("../../shared/db.js");
  const clear = initDb().prepare("DELETE FROM plugin_kv");
  clearPluginStorage = () => void clear.run();
});

beforeEach(() => {
  resetPlugins();
  // Plugin storage outlives the plugins directory — it is in the registry
  // database, not under plugins/ — so the counting registrar below needs it
  // emptied to count this test's imports rather than the whole file's.
  clearPluginStorage();
  writeConfig({ enabled: ["inbox"] });
  onConfigReload();
});

describe("an enabled plugin's own routes", () => {
  it("answers with the registrar's status and body", async () => {
    installBackend("inbox", pinger(`{ from: "inbox", ok: true }`));

    const pinged = await call("GET", "/api/plugins/inbox/ping");
    expect(pinged.status).toBe(200);
    expect(pinged.body).toEqual({ from: "inbox", ok: true });
  });

  it("routes by method as well as path", async () => {
    installBackend(
      "inbox",
      `export default () => ({
        "POST /items": (req, res) => { res.writeHead(201, {}); res.end("created"); },
      });`,
    );

    expect((await call("POST", "/api/plugins/inbox/items")).status).toBe(201);
    // Same path, method the registrar never registered.
    expect((await call("GET", "/api/plugins/inbox/items")).status).toBe(404);
  });

  it("404s a path the registrar did not register", async () => {
    installBackend("inbox", pinger(`{ ok: true }`));
    expect((await call("GET", "/api/plugins/inbox/nothing-here")).status).toBe(404);
  });

  it("404s a loaded plugin that declares no server entry", async () => {
    install("inbox", { id: "inbox" }, { "client.js": "export default {}" });

    const listed = await call("GET", "/api/plugins");
    expect(listed.body.plugins[0]).toMatchObject({ id: "inbox", status: "loaded", kind: "client" });
    expect((await call("GET", "/api/plugins/inbox/ping")).status).toBe(404);
  });

  it("404s when the declared server entry is not on disk", async () => {
    install("inbox", { id: "inbox", server: "server.js" }, { "client.js": "export default {}" });
    expect((await call("GET", "/api/plugins/inbox/ping")).status).toBe(404);
  });

  it("leaves the client and asset routes answering as they did", async () => {
    install(
      "inbox",
      { id: "inbox", server: "server.js" },
      { "server.js": pinger(`{ ok: true }`), "assets/logo.svg": "<svg/>" },
    );

    expect((await call("GET", "/api/plugins/inbox/client")).bodyText).toBe("export default { id: 'x' }");
    expect((await call("GET", "/api/plugins/inbox/assets/logo.svg")).bodyText).toBe("<svg/>");
    expect((await call("GET", "/api/plugins/inbox/ping")).body).toEqual({ ok: true });
  });
});

describe("hot reload", () => {
  it("serves the edited file on the next request, with no restart and no rescan", async () => {
    installBackend("inbox", pinger(`{ version: "one" }`));
    expect((await call("GET", "/api/plugins/inbox/ping")).body).toEqual({ version: "one" });

    rewriteServer("inbox", pinger(`{ version: "two", added: "a route that was not there" }`));

    const reloaded = await call("GET", "/api/plugins/inbox/ping");
    expect(reloaded.body).toEqual({ version: "two", added: "a route that was not there" });
  });

  it("drops a route the new version no longer registers", async () => {
    installBackend(
      "inbox",
      `export default () => ({
        "GET /ping": (req, res) => { res.writeHead(200, {}); res.end("pong"); },
        "GET /legacy": (req, res) => { res.writeHead(200, {}); res.end("legacy"); },
      });`,
    );
    expect((await call("GET", "/api/plugins/inbox/legacy")).status).toBe(200);

    rewriteServer("inbox", pinger(`{ version: "two" }`));
    expect((await call("GET", "/api/plugins/inbox/legacy")).status).toBe(404);
    expect((await call("GET", "/api/plugins/inbox/ping")).status).toBe(200);
  });
});

/** A registrar that counts its own imports in the plugin's storage, so a response
 *  says how many times the module has actually been evaluated. */
const COUNTING_REGISTRAR = `export default (ctx) => {
  const loads = (ctx.storage.get("loads") ?? 0) + 1;
  ctx.storage.set("loads", loads);
  return {
    "GET /ping": (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ loads, settings: ctx.settings }));
    },
  };
};`;

describe("the runtime enable gate", () => {
  beforeEach(() => {
    installBackend("inbox", COUNTING_REGISTRAR);
  });

  it("404s the very next request after the plugin leaves plugins.enabled", async () => {
    expect((await call("GET", "/api/plugins/inbox/ping")).status).toBe(200);

    writeConfig({ enabled: [] });
    onConfigReload();
    expect((await call("GET", "/api/plugins/inbox/ping")).status).toBe(404);
  });

  it("404s the very next request after the plugin is added to plugins.disabled", async () => {
    expect((await call("GET", "/api/plugins/inbox/ping")).status).toBe(200);

    writeConfig({ enabled: ["inbox"], disabled: ["inbox"] });
    onConfigReload();
    expect((await call("GET", "/api/plugins/inbox/ping")).status).toBe(404);
  });

  it("re-imports the module when the plugin is enabled again", async () => {
    expect((await call("GET", "/api/plugins/inbox/ping")).body.loads).toBe(1);
    // Still the same incarnation while it stays enabled and the file is untouched.
    expect((await call("GET", "/api/plugins/inbox/ping")).body.loads).toBe(1);

    writeConfig({ enabled: [] });
    onConfigReload();
    expect((await call("GET", "/api/plugins/inbox/ping")).status).toBe(404);

    writeConfig({ enabled: ["inbox"] });
    onConfigReload();
    expect((await call("GET", "/api/plugins/inbox/ping")).body.loads).toBe(2);
  });

  it.each([
    ["an id nothing is installed under", "/api/plugins/nothing-installed/ping"],
    ["an id the plugin pattern refuses", "/api/plugins/Inbox/ping"],
    ["an id too short to be a plugin", "/api/plugins/a/ping"],
  ])("404s %s without a 500 or a stack trace", async (_case, urlPath) => {
    const refused = await call("GET", urlPath);
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ error: "Not found" });
  });

  it("404s a plugin whose manifest never loaded, even while it is enabled", async () => {
    install("broken", { id: "mismatched", server: "server.js" }, { "server.js": pinger(`{ ok: true }`) });
    writeConfig({ enabled: ["broken"] });
    onConfigReload();

    const refused = await call("GET", "/api/plugins/broken/ping");
    expect(refused.status).toBe(404);
    expect(refused.bodyText).not.toContain("at ");
  });
});

/** A registrar whose module body — not its registrar — counts, and reports the
 *  count it was evaluated under. Counting inside the registrar would not tell the
 *  two cases apart: re-invoking the registrar of a module Node still has cached
 *  looks exactly like evaluating the file again. */
const EVALUATION_COUNTING_REGISTRAR = `const evaluations = (globalThis.__inboxEvaluations = (globalThis.__inboxEvaluations ?? 0) + 1);
export default () => ({
  "GET /ping": (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ evaluations }));
  },
});`;

describe("re-enabling a plugin re-evaluates its server.js", () => {
  beforeEach(() => {
    delete (globalThis as { __inboxEvaluations?: number }).__inboxEvaluations;
    installBackend("inbox", EVALUATION_COUNTING_REGISTRAR);
  });

  it("evaluates the file again after a disable and a re-enable, with the file untouched", async () => {
    expect((await call("GET", "/api/plugins/inbox/ping")).body.evaluations).toBe(1);

    writeConfig({ enabled: [] });
    onConfigReload();
    expect((await call("GET", "/api/plugins/inbox/ping")).status).toBe(404);

    writeConfig({ enabled: ["inbox"] });
    onConfigReload();
    expect((await call("GET", "/api/plugins/inbox/ping")).body.evaluations).toBe(2);
  });

  it("does so when no request arrives while the plugin is disabled", async () => {
    expect((await call("GET", "/api/plugins/inbox/ping")).body.evaluations).toBe(1);

    writeConfig({ enabled: [] });
    onConfigReload();
    writeConfig({ enabled: ["inbox"] });
    onConfigReload();

    expect((await call("GET", "/api/plugins/inbox/ping")).body.evaluations).toBe(2);
  });
});

describe("ctx.settings", () => {
  beforeEach(() => {
    installBackend("inbox", COUNTING_REGISTRAR);
  });

  it("is an empty object when the operator has written no settings", async () => {
    expect((await call("GET", "/api/plugins/inbox/ping")).body.settings).toEqual({});
  });

  it("is the plugin's own slice of config.plugins.settings", async () => {
    writeConfig({ enabled: ["inbox"], settings: { inbox: { folder: "archive" }, other: { folder: "spam" } } });
    onConfigReload();
    expect((await call("GET", "/api/plugins/inbox/ping")).body.settings).toEqual({ folder: "archive" });
  });

  it("follows a config.yaml edit without a restart and without re-importing the plugin", async () => {
    const first = await call("GET", "/api/plugins/inbox/ping");
    expect(first.body).toEqual({ loads: 1, settings: {} });

    writeConfig({ enabled: ["inbox"], settings: { inbox: { folder: "archive" } } });
    onConfigReload();

    // The registrar ran once and is still that incarnation: the new value came
    // from reading the config on this request, not from re-evaluating the module.
    expect((await call("GET", "/api/plugins/inbox/ping")).body).toEqual({
      loads: 1,
      settings: { folder: "archive" },
    });
  });
});
