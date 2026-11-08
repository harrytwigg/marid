import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { call, install, resetPlugins, startHarness, writeConfig } from "./plugins-api-harness.js";

/**
 * The reference plugin in `examples/plugins/inbox-demo/`, run by the real
 * gateway.
 *
 * The point of this case is that the files are the ones a reader is pointed at.
 * `examples/` is outside every tsconfig, and the lint config,
 * so nothing else in CI would notice the day the demo stops working — and a
 * broken example is worse than none, because it is the first thing somebody
 * copies.
 */

const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../examples/plugins/inbox-demo");

function demoFile(name: string): string {
  return fs.readFileSync(path.join(DEMO_DIR, name), "utf-8");
}

let onConfigReload: () => void;
let reconcileWatchers: () => Promise<void>;
let clearDemoStorage: () => void;
let inboxDir: string;

/** The demo's watched directory, pointed somewhere disposable for the run. */
function installDemo(): void {
  install("inbox-demo", JSON.parse(demoFile("plugin.json")), {
    "client.js": demoFile("client.js"),
    "server.js": demoFile("server.js"),
  });
  writeConfig({ enabled: ["inbox-demo"], settings: { "inbox-demo": { inboxDir } } });
  onConfigReload();
}

beforeAll(async () => {
  ({ onConfigReload, reconcileWatchers } = await startHarness());
  const { pluginStorage } = await import("../../plugins/storage.js");
  // Plugin storage is the instance's database, not the plugins directory, so
  // `resetPlugins` does not touch it and one case's messages would otherwise be
  // waiting for the next.
  clearDemoStorage = () => {
    const storage = pluginStorage("inbox-demo");
    for (const key of storage.keys()) storage.delete(key);
  };
});

beforeEach(async () => {
  resetPlugins();
  writeConfig({ enabled: [] });
  onConfigReload();
  await reconcileWatchers();
  clearDemoStorage();
  inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-demo-case-"));
});

describe("the inbox-demo reference plugin", () => {
  it("discovers as a client+server plugin and loads when enabled", async () => {
    installDemo();

    const inventory = (await call("GET", "/api/plugins")).body.inventory;
    expect(inventory).toContainEqual(
      expect.objectContaining({ id: "inbox-demo", kind: "client+server", status: "loaded" }),
    );
  });

  it("answers its own backend route", async () => {
    installDemo();

    const answer = await call("GET", "/api/plugins/inbox-demo/messages");

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ messages: [] });
  });

  it("turns a file dropped in the inbox into a message its route reports", async () => {
    fs.writeFileSync(path.join(inboxDir, "welcome.txt"), "hello");
    installDemo();
    await reconcileWatchers();

    const { messages } = (await call("GET", "/api/plugins/inbox-demo/messages")).body;
    expect(messages).toEqual([expect.objectContaining({ id: "welcome.txt", state: "pending" })]);
  });

  it("approving mutates storage and appends an event the events route serves", async () => {
    fs.writeFileSync(path.join(inboxDir, "invoice.txt"), "hello");
    installDemo();
    await reconcileWatchers();

    const approved = await call(
      "POST",
      "/api/plugins/inbox-demo/approve",
      { authorization: "Bearer test-token" },
      { id: "invoice.txt" },
    );
    expect(approved.status).toBe(200);

    const { messages } = (await call("GET", "/api/plugins/inbox-demo/messages")).body;
    expect(messages[0]).toMatchObject({ id: "invoice.txt", state: "approved" });

    const page = (await call("GET", "/api/plugins/inbox-demo/events?since=0")).body;
    expect(page.events.map((record: { event: unknown }) => record.event)).toContainEqual({
      type: "approved",
      id: "invoice.txt",
    });
  });

  it("refuses to decide about a message it does not have", async () => {
    installDemo();

    const answer = await call(
      "POST",
      "/api/plugins/inbox-demo/reject",
      { authorization: "Bearer test-token" },
      { id: "never-arrived.txt" },
    );

    expect(answer.status).toBe(404);
  });

  it("watches a directory outside the plugins directory", async () => {
    // The gateway watches `plugins/` recursively to hot-reload plugins, so an
    // inbox inside it would make every dropped file rescan and reload the very
    // plugin reading it. Read off the demo's own resolver rather than off a
    // comment, so the day somebody changes the default this fails.
    const { inboxDirectory } = (await import(path.join(DEMO_DIR, "server.js"))) as {
      inboxDirectory: (settings?: Record<string, unknown>) => string;
    };
    const { PLUGINS_DIR } = await import("../../shared/paths.js");

    for (const resolved of [inboxDirectory(), inboxDirectory({}), inboxDirectory({ inboxDir })]) {
      expect(path.relative(PLUGINS_DIR, resolved).startsWith("..")).toBe(true);
    }
  });
});
