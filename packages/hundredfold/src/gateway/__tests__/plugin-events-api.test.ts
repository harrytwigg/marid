import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, install, resetPlugins, startHarness, writeConfig } from "./plugins-api-harness.js";

let onConfigReload: () => void;
let reconcileWatchers: () => Promise<void>;

/**
 * A plugin that records what the gateway did to it on `globalThis`, which
 * survives the cache-busting re-import a reload causes. `imported` separates
 * "the module was evaluated" from "the watcher was started" — the distinction
 * AC1 is about.
 */
const SERVER_JS = `
const seen = (globalThis.__mailbox ??= { imported: 0, registered: 0, started: 0, stopped: 0 });
seen.imported++;
export const watcher = {
  start() { seen.started++; },
  stop() { seen.stopped++; },
};
export default (ctx) => (seen.registered++, {
  "GET /emit": (req, res) => {
    const count = Number(new URL(req.url, "http://gateway").searchParams.get("count") ?? "1");
    for (let n = 0; n < count; n++) ctx.emit({ tick: n });
    res.writeHead(200);
    res.end("emitted");
  },
  // A plugin cannot take the gateway's events lane by registering it.
  "GET /events": (req, res) => {
    res.writeHead(200);
    res.end("the plugin's own events");
  },
});
`;

interface Seen {
  imported: number;
  registered: number;
  started: number;
  stopped: number;
}

const NOTHING_SEEN: Seen = { imported: 0, registered: 0, started: 0, stopped: 0 };

function seen(): Seen {
  return (globalThis as { __mailbox?: Seen }).__mailbox ?? NOTHING_SEEN;
}

/** Event rings live for the process and are never cleared, so each case gets its
 *  own plugin id and can assert on absolute cursors. */
let counter = 0;
function installMailbox(): string {
  const id = `mailbox-${counter++}`;
  install(id, { id, name: "Mailbox", version: "1.0.0", server: "server.js" }, { "server.js": SERVER_JS });
  writeConfig({ enabled: [id] });
  onConfigReload();
  return id;
}

beforeAll(async () => {
  ({ onConfigReload, reconcileWatchers } = await startHarness());
});

beforeEach(async () => {
  resetPlugins();
  writeConfig({ enabled: [] });
  onConfigReload();
  await reconcileWatchers();
  delete (globalThis as { __mailbox?: Seen }).__mailbox;
});

describe("watcher lifecycle", () => {
  it("does not start a watcher merely because the module was imported", async () => {
    // Listed first and installed afterwards, so the enable edge has already
    // reconciled and found nothing on disk. The only thing that reaches this
    // module is the request below — an import with no supervision behind it.
    const id = `mailbox-${counter++}`;
    writeConfig({ enabled: [id] });
    onConfigReload();
    await reconcileWatchers();
    install(id, { id, name: "Mailbox", version: "1.0.0", server: "server.js" }, { "server.js": SERVER_JS });

    expect((await call("GET", `/api/plugins/${id}/emit`)).status).toBe(200);

    expect(seen().imported).toBe(1);
    expect(seen().started).toBe(0);
  });

  it("starts an enabled plugin's watcher exactly once", async () => {
    installMailbox();

    await reconcileWatchers();
    expect(seen().started).toBe(1);

    // Boot, a config reload and a rescan all reconcile. Nothing changed, so the
    // watcher already running is left alone.
    await reconcileWatchers();
    expect(seen().started).toBe(1);
    expect(seen().stopped).toBe(0);
  });

  it("stops the watcher when the operator disables the plugin", async () => {
    const id = installMailbox();
    await reconcileWatchers();

    writeConfig({ enabled: [], disabled: [id] });
    onConfigReload();
    await reconcileWatchers();

    expect(seen().stopped).toBe(1);
  });

  it("registers once when a request and the supervisor load it at the same moment", async () => {
    const id = installMailbox();

    // Both miss the cache. Only one may reach the registrar: two would leave the
    // process running a plugin's setup twice, under two different contexts.
    await Promise.all([call("GET", `/api/plugins/${id}/emit`), reconcileWatchers()]);

    expect(seen().registered).toBe(1);
    expect(seen().started).toBe(1);
  });

  it("stops the old incarnation before the edited one starts", async () => {
    const id = installMailbox();
    await reconcileWatchers();

    install(id, { id, name: "Mailbox", version: "1.0.0", server: "server.js" }, {
      "server.js": `${SERVER_JS}\n// an edit, which is a new incarnation\n`,
    });
    await reconcileWatchers();

    // Evaluated twice, and the watcher the first evaluation started was stopped
    // before the second one was asked to start.
    expect(seen().imported).toBe(2);
    expect(seen().stopped).toBe(1);
    expect(seen().started).toBe(2);
  });

  it("reports watcher health on the inventory row, and none for a plugin without one", async () => {
    const id = installMailbox();
    install("plain", { id: "plain", name: "Plain", version: "1.0.0" });
    await reconcileWatchers();

    const inventory = (await call("GET", "/api/plugins")).body.inventory as Record<string, unknown>[];

    expect(inventory.find((row) => row.id === id)?.watcher).toEqual({ status: "running", restarts: 0 });
    expect(inventory.find((row) => row.id === "plain")).not.toHaveProperty("watcher");
  });

  it("keeps reporting the watcher of a disabled plugin, stopped", async () => {
    const id = installMailbox();
    await reconcileWatchers();

    writeConfig({ enabled: [], disabled: [id] });
    onConfigReload();
    await reconcileWatchers();

    const row = ((await call("GET", "/api/plugins")).body.inventory as Record<string, unknown>[]).find(
      (entry) => entry.id === id,
    );
    // Disabled says what the operator chose; the watcher row says what became of
    // the background task that choice turned off.
    expect(row?.status).toBe("disabled");
    expect(row?.watcher).toEqual({ status: "stopped", restarts: 0 });
  });
});

describe("GET /api/plugins/<id>/events", () => {
  it("returns what the plugin emitted, and only what came after a cursor", async () => {
    const id = installMailbox();
    await call("GET", `/api/plugins/${id}/emit?count=2`);

    const all = await call("GET", `/api/plugins/${id}/events`);
    expect(all.status).toBe(200);
    expect(all.body.events).toEqual([
      { cursor: 1, event: { tick: 0 } },
      { cursor: 2, event: { tick: 1 } },
    ]);
    expect(all.body.cursor).toBe(2);
    expect(all.body.dropped).toBe(false);

    await call("GET", `/api/plugins/${id}/emit?count=1`);
    const since = await call("GET", `/api/plugins/${id}/events?since=2`);
    expect(since.body.events).toEqual([{ cursor: 3, event: { tick: 0 } }]);
    expect(since.body.cursor).toBe(3);
  });

  it("says so when the caller's cursor predates what the ring still holds", async () => {
    const id = installMailbox();
    await call("GET", `/api/plugins/${id}/emit?count=1000`);

    const stale = await call("GET", `/api/plugins/${id}/events?since=0`);
    expect(stale.body.dropped).toBe(true);
    expect(stale.body.events.length).toBeLessThan(1000);

    const current = await call("GET", `/api/plugins/${id}/events?since=${stale.body.cursor}`);
    expect(current.body).toEqual({ events: [], cursor: stale.body.cursor, dropped: false });
  });

  it("keeps one plugin's events out of another's lane", async () => {
    const id = installMailbox();
    install("other", { id: "other", name: "Other", version: "1.0.0", server: "server.js" }, {
      "server.js": "export default () => ({});",
    });
    writeConfig({ enabled: [id, "other"] });
    onConfigReload();
    await call("GET", `/api/plugins/${id}/emit?count=1`);

    expect((await call("GET", "/api/plugins/other/events")).body.events).toEqual([]);
  });

  it("refuses a cursor that is not one", async () => {
    const id = installMailbox();
    const bad = await call("GET", `/api/plugins/${id}/events?since=yesterday`);

    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/non-negative integer/);
  });

  it("is not shadowed by a plugin that registers its own GET /events", async () => {
    const id = installMailbox();
    const answered = await call("GET", `/api/plugins/${id}/events`);

    expect(answered.bodyText).not.toContain("the plugin's own events");
    expect(answered.body).toEqual({ events: [], cursor: 0, dropped: false });
  });

  it("answers a disabled and an unknown plugin identically", async () => {
    const id = installMailbox();
    writeConfig({ enabled: [], disabled: [id] });
    onConfigReload();

    const disabled = await call("GET", `/api/plugins/${id}/events`);
    const unknown = await call("GET", "/api/plugins/nosuchplugin/events");

    expect(disabled.status).toBe(404);
    expect(disabled.status).toBe(unknown.status);
    expect(disabled.bodyText).toBe(unknown.bodyText);
  });
});
