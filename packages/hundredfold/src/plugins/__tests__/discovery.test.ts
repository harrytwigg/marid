import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// HUNDREDFOLD_HOME has to be set before anything reaches paths.js, which reads it once.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-plugin-discovery-"));
process.env.HUNDREDFOLD_HOME = tmpHome;
const pluginsDir = path.join(tmpHome, "plugins");

type Discovery = typeof import("../discovery.js");
let discovery: Discovery;

/** A plugin directory carrying whatever manifest and files the case needs. */
function install(id: string, manifest: unknown, files: Record<string, string> = { "client.js": "export default {}" }): void {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

async function rowFor(id: string) {
  const found = (await discovery.scanPlugins()).find((plugin) => plugin.id === id);
  if (!found) throw new Error(`no inventory row for "${id}"`);
  return found;
}

beforeAll(async () => {
  discovery = await import("../discovery.js");
});

beforeEach(() => {
  fs.rmSync(pluginsDir, { recursive: true, force: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
});

describe("inventory", () => {
  it("records the halves a manifest declares", async () => {
    install("alpha", { id: "alpha", name: "Alpha", version: "1.0.0" });
    install("beta", { id: "beta", server: "server.js" }, { "client.js": "//", "server.js": "//" });

    expect(discovery.inventoryRow(await rowFor("alpha"))).toEqual({
      id: "alpha",
      name: "Alpha",
      version: "1.0.0",
      kind: "client",
      status: "loaded",
    });
    expect(discovery.inventoryRow(await rowFor("beta"))).toEqual({
      id: "beta",
      name: "beta",
      version: "0.0.0",
      kind: "client+server",
      status: "loaded",
    });
  });

  it("keeps the resolved entries off the wire", async () => {
    install("alpha", { id: "alpha" });
    const row = discovery.inventoryRow(await rowFor("alpha"));
    expect(Object.keys(row)).toEqual(["id", "name", "version", "kind", "status"]);
  });

  it("yields one record per directory, in id order, ignoring loose files", async () => {
    install("gamma", { id: "gamma" });
    install("alpha", { id: "alpha" });
    fs.writeFileSync(path.join(pluginsDir, "README.md"), "not a plugin");

    expect((await discovery.scanPlugins()).map((plugin) => plugin.id)).toEqual(["alpha", "gamma"]);
  });

  it("is zero plugins when the directory does not exist, not a failure", async () => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
    await expect(discovery.scanPlugins()).resolves.toEqual([]);
  });
});

describe("a broken plugin keeps its row", () => {
  it.each([
    ["no plugin.json at all", undefined, /plugin\.json/],
    ["a manifest that is not JSON", "{oops", /JSON/],
    ["an id that is not its folder name", { id: "elsewhere" }, /broken/],
    ["a reserved id", { id: "hundredfold" }, /reserved/],
    ["an id of the wrong shape", { id: "Broken" }, /id/],
  ])("records %s as an error row rather than dropping it", async (_label, manifest, pattern) => {
    const raw = typeof manifest === "string";
    install("broken", raw ? undefined : manifest);
    if (raw) fs.writeFileSync(path.join(pluginsDir, "broken", "plugin.json"), manifest as string);

    const row = await rowFor("broken");
    expect(row.status).toBe("error");
    expect(row.error).toMatch(pattern);
    expect(row.client).toBeNull();
  });

  it("records a manifest whose client file is absent", async () => {
    install("broken", { id: "broken" }, {});
    const row = await rowFor("broken");
    expect(row.status).toBe("error");
    expect(row.error).toMatch(/client/);
  });

  it("records an external client symlink as an error with no client half", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-plugin-client-outside-"));
    try {
      install("broken", { id: "broken" });
      const client = path.join(pluginsDir, "broken", "client.js");
      fs.rmSync(client);
      fs.writeFileSync(path.join(outside, "client.js"), "export const outside = true");
      fs.symlinkSync(path.join(outside, "client.js"), client);

      const row = await rowFor("broken");
      expect(row.status).toBe("error");
      expect(row.client).toBeNull();
      expect(row.error).toMatch(/client/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("loads the client half when only the server entry is rejected", async () => {
    install("half", { id: "half", server: "../escape.js" });
    const row = await rowFor("half");
    expect(row.status).toBe("loaded");
    // `.native` because the module resolves with the async `fs.realpath`, which goes through libuv
    // and expands a Windows 8.3 short name (`RUNNER~1` -> `runneradmin`). The JS `realpathSync`
    // only walks symlinks and leaves the short form intact, so the two spell one path two ways.
    expect(row.client).toBe(fs.realpathSync.native(path.join(pluginsDir, "half", "client.js")));
    expect(row.server).toBeNull();
    expect(row.error).toMatch(/server/);
  });
});

describe("loadPlugin", () => {
  it("reads the one plugin an id names", async () => {
    install("alpha", { id: "alpha" });
    expect((await discovery.loadPlugin("alpha"))?.status).toBe("loaded");
  });

  it("is null for an id nothing is installed under", async () => {
    await expect(discovery.loadPlugin("nothing")).resolves.toBeNull();
  });
});

describe("re-entrancy", () => {
  it("shares one scan rather than overlapping a second onto it", async () => {
    install("alpha", { id: "alpha" });
    const first = discovery.scanPlugins();
    const second = discovery.scanPlugins();
    expect(second).toBe(first);
    await first;
  });

  it("releases the guard, so the next scan sees the disk again", async () => {
    install("alpha", { id: "alpha" });
    expect((await discovery.scanPlugins()).map((plugin) => plugin.id)).toEqual(["alpha"]);

    install("beta", { id: "beta" });
    expect((await discovery.scanPlugins()).map((plugin) => plugin.id)).toEqual(["alpha", "beta"]);
  });
});
