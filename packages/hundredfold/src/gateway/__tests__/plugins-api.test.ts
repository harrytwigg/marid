import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { call, install, pluginsDir, resetPlugins, startHarness, writeConfig } from "./plugins-api-harness.js";

let authRequiredForRequest: (typeof import("../auth.js"))["authRequiredForRequest"];
let onConfigReload: () => void;
let routePrefix: string;

beforeAll(async () => {
  ({ authRequiredForRequest, onConfigReload, routePrefix } = await startHarness());
});

beforeEach(() => {
  resetPlugins();
  writeConfig({ enabled: ["inbox"] });
  onConfigReload();
  install("inbox", { id: "inbox", name: "Inbox", version: "2.0.0", server: "server.js" }, {
    // A loadable registrar that registers nothing: the backend mount now answers
    // every path below this plugin, so a server entry that fails to import would
    // turn these 404s into its 500 and stop testing the route. The sentinel
    // string is what the assertions below look for on the wire.
    "server.js": "// gateway-side source\nexport default () => ({});",
    "assets/logo.svg": "<svg/>",
    "assets/panel.css": "body{}",
    "assets/notes.txt": "not an asset type",
    "assets/nested/chip.js": "export const chip = 1",
  });
});

describe("GET /api/plugins", () => {
  it("returns the enabled manifests, with the whole inventory beside them", async () => {
    install("shelved", { id: "shelved" });
    const listed = await call("GET", "/api/plugins");

    expect(listed.status).toBe(200);
    expect(listed.body.plugins).toEqual([
      { id: "inbox", name: "Inbox", version: "2.0.0", kind: "client+server", status: "loaded" },
    ]);
    expect(listed.body.inventory).toEqual([
      { id: "inbox", name: "Inbox", version: "2.0.0", kind: "client+server", status: "loaded" },
      { id: "shelved", name: "shelved", version: "0.0.0", kind: "client", status: "disabled" },
    ]);
  });

  it("keeps a plugin listed in both lists disabled", async () => {
    writeConfig({ enabled: ["inbox"], disabled: ["inbox"] });
    onConfigReload();
    const listed = await call("GET", "/api/plugins");
    expect(listed.body.plugins).toEqual([]);
    expect(listed.body.inventory[0].status).toBe("disabled");
  });

  it("keeps a broken plugin in the inventory with its error", async () => {
    install("broken", { id: "elsewhere" });
    const inventory = (await call("GET", "/api/plugins")).body.inventory;
    const broken = inventory.find((row: { id: string }) => row.id === "broken");
    expect(broken.status).toBe("error");
    expect(broken.error).toContain("broken");
  });

  it("is an empty inventory when nothing is installed", async () => {
    fs.rmSync(pluginsDir, { recursive: true, force: true });
    const listed = await call("GET", "/api/plugins");
    expect(listed.body).toEqual({ plugins: [], inventory: [] });
  });
});

describe("POST /api/plugins/rescan", () => {
  it("re-reads the disk and answers with the fresh inventory", async () => {
    expect((await call("GET", "/api/plugins")).body.inventory).toHaveLength(1);

    install("added", { id: "added" });
    const rescanned = await call("POST", "/api/plugins/rescan");
    expect(rescanned.status).toBe(200);
    expect(rescanned.body.inventory.map((row: { id: string }) => row.id)).toEqual(["added", "inbox"]);
  });

  it("is operator-only control-plane authority", async () => {
    const anonymous = await call("POST", "/api/plugins/rescan", {});
    expect(anonymous.status).toBe(403);
  });
});

describe("GET /api/plugins/:id/client", () => {
  it("serves the manifest's client entry, uncached", async () => {
    const served = await call("GET", "/api/plugins/inbox/client");
    expect(served.status).toBe(200);
    expect(served.bodyText).toBe("export default { id: 'x' }");
    expect(served.headers["Cache-Control"]).toBe("no-store");
  });

  it("takes no caller-supplied path — the route has nowhere to put one", async () => {
    for (const spelling of [
      "/api/plugins/inbox/client/server.js",
      "/api/plugins/inbox/client/../server.js",
      "/api/plugins/inbox/client?path=server.js",
      "/api/plugins/inbox/client/..%2fserver.js",
    ]) {
      const served = await call("GET", spelling);
      expect(`${spelling} → ${served.bodyText}`).not.toContain("gateway-side source");
    }
  });

  it("serves the entry the manifest names, not the conventional filename", async () => {
    install("named", { id: "named", client: "ui.js" }, { "ui.js": "export const ui = 1", "client.js": "export const wrong = 1" });
    writeConfig({ enabled: ["named"] });
    onConfigReload();
    expect((await call("GET", "/api/plugins/named/client")).bodyText).toBe("export const ui = 1");
  });

  it("keeps a client symlink escaping its plugin as an inventory error", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-plugin-client-outside-"));
    try {
      const target = path.join(outside, "client.js");
      fs.writeFileSync(target, "export const outside = true");
      fs.rmSync(path.join(pluginsDir, "inbox", "client.js"));
      fs.symlinkSync(target, path.join(pluginsDir, "inbox", "client.js"));

      const inventory = (await call("GET", "/api/plugins")).body.inventory;
      const inbox = inventory.find((row: { id: string }) => row.id === "inbox");
      expect(inbox.status).toBe("error");
      expect(inbox.error).toContain("client");
      expect((await call("GET", "/api/plugins/inbox/client")).status).toBe(404);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("discovers a symlinked plugin directory and serves its own files", async () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-plugin-checkout-"));
    try {
      fs.writeFileSync(path.join(checkout, "plugin.json"), JSON.stringify({ id: "linked" }));
      fs.writeFileSync(path.join(checkout, "client.js"), "export const linked = true");
      fs.mkdirSync(path.join(checkout, "assets"));
      fs.writeFileSync(path.join(checkout, "assets", "logo.svg"), "<linked/>");
      fs.symlinkSync(checkout, path.join(pluginsDir, "linked"), "dir");
      writeConfig({ enabled: ["linked"] });
      onConfigReload();

      expect((await call("GET", "/api/plugins")).body.inventory).toContainEqual({
        id: "linked",
        name: "linked",
        version: "0.0.0",
        kind: "client",
        status: "loaded",
      });
      expect((await call("GET", "/api/plugins/linked/client")).bodyText).toBe("export const linked = true");
      expect((await call("GET", "/api/plugins/linked/assets/logo.svg")).bodyText).toBe("<linked/>");
    } finally {
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  });
});

describe("GET /api/plugins/:id/assets/*", () => {
  it("serves an allowlisted file from the plugin's assets directory, uncached", async () => {
    const svg = await call("GET", "/api/plugins/inbox/assets/logo.svg");
    expect(svg.status).toBe(200);
    expect(svg.bodyText).toBe("<svg/>");
    expect(svg.headers["Content-Type"]).toBe("image/svg+xml");
    expect(svg.headers["Cache-Control"]).toBe("no-store");

    expect((await call("GET", "/api/plugins/inbox/assets/nested/chip.js")).status).toBe(200);
    expect((await call("GET", "/api/plugins/inbox/assets/panel.css")).headers["Content-Type"]).toBe("text/css");
  });

  it("404s a suffix outside the allowlist rather than admitting the file exists", async () => {
    const txt = await call("GET", "/api/plugins/inbox/assets/notes.txt");
    expect(txt.status).toBe(404);
    expect(txt.bodyText).not.toContain("not an asset type");
  });

  it("404s a missing file inside the allowlist", async () => {
    expect((await call("GET", "/api/plugins/inbox/assets/absent.svg")).status).toBe(404);
  });

  it.each([
    "/api/plugins/inbox/assets/../server.js",
    "/api/plugins/inbox/assets/..%2fserver.js",
    "/api/plugins/inbox/assets/%2e%2e/server.js",
    "/api/plugins/inbox/assets/nested/../../server.js",
    "/api/plugins/inbox/assets//tmp/evil.js",
    "/api/plugins/inbox/assets/../../inbox-extra/evil.js",
  ])("404s %s instead of escaping the assets directory", async (urlPath) => {
    const escaped = await call("GET", urlPath);
    expect(escaped.status).toBe(404);
    expect(escaped.bodyText).not.toContain("gateway-side source");
  });

  it("cannot reach the plugin's server.js by any spelling", async () => {
    fs.writeFileSync(path.join(pluginsDir, "inbox", "assets", "server.js"), "// an asset that shares a name");
    for (const spelling of [
      "/api/plugins/inbox/assets/../server.js",
      "/api/plugins/inbox/assets/./../server.js",
      "/api/plugins/inbox/assets/%2e%2e%2fserver.js",
      "/api/plugins/inbox/assets/nested/../../server.js",
    ]) {
      const served = await call("GET", spelling);
      expect(`${spelling} → ${served.bodyText}`).not.toContain("gateway-side source");
    }
    // The asset of the same name inside assets/ is still served — the root moved,
    // the suffix did not become forbidden.
    expect((await call("GET", "/api/plugins/inbox/assets/server.js")).bodyText).toBe("// an asset that shares a name");
  });

  it("does not serve an asset symlink whose target escapes the assets directory", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-plugin-asset-outside-"));
    try {
      const target = path.join(outside, "secret.svg");
      fs.writeFileSync(target, "asset symlink secret");
      fs.symlinkSync(target, path.join(pluginsDir, "inbox", "assets", "secret.svg"));

      const served = await call("GET", "/api/plugins/inbox/assets/secret.svg");
      expect(served.status).toBe(404);
      expect(served.bodyText).not.toContain("asset symlink secret");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not let an asset symlink expose a plugin server entry", async () => {
    fs.symlinkSync(
      path.join(pluginsDir, "inbox", "server.js"),
      path.join(pluginsDir, "inbox", "assets", "server-entry.js"),
    );

    const served = await call("GET", "/api/plugins/inbox/assets/server-entry.js");
    expect(served.status).toBe(404);
    expect(served.bodyText).not.toContain("gateway-side source");
  });

  it("does not follow an assets directory symlink outside the plugin", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-plugin-assets-root-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "logo.svg"), "assets root secret");
      fs.rmSync(path.join(pluginsDir, "inbox", "assets"), { recursive: true, force: true });
      fs.symlinkSync(outside, path.join(pluginsDir, "inbox", "assets"), "dir");

      const served = await call("GET", "/api/plugins/inbox/assets/logo.svg");
      expect(served.status).toBe(404);
      expect(served.bodyText).not.toContain("assets root secret");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("the enable gate on both routes", () => {
  it.each(["/api/plugins/inbox/client", "/api/plugins/inbox/assets/logo.svg"])(
    "404s %s after config reload disables the plugin",
    async (urlPath) => {
      expect((await call("GET", urlPath)).status).toBe(200);

      writeConfig({ enabled: [] });
      expect((await call("GET", urlPath)).status).toBe(200);
      onConfigReload();
      expect((await call("GET", urlPath)).status).toBe(404);

      writeConfig({ enabled: ["inbox"], disabled: ["inbox"] });
      onConfigReload();
      expect((await call("GET", urlPath)).status).toBe(404);
    },
  );

  it.each([
    "/api/plugins/unknown/client",
    "/api/plugins/unknown/assets/logo.svg",
    "/api/plugins/Inbox/client",
  ])("404s %s", async (urlPath) => {
    expect((await call("GET", urlPath)).status).toBe(404);
  });

  it("404s a plugin whose manifest never loaded, even while it is enabled", async () => {
    install("broken", { id: "elsewhere" });
    writeConfig({ enabled: ["broken"] });
    onConfigReload();
    expect((await call("GET", "/api/plugins/broken/client")).status).toBe(404);
  });

  // The gate must never answer before auth does: an anonymous caller walking
  // /api/plugins/<guess>/ would otherwise read enabled-versus-not off the status
  // code and learn which plugins the operator has installed. The ordering is
  // structural — the server's auth gate returns 401 before handleApiRequest runs
  // — and it holds because these paths sit under /api/.
  it.each(["", "inbox/client", "inbox/assets/logo.svg"])(
    "mounts %s inside the namespace the auth gate covers",
    (suffix) => {
      expect(authRequiredForRequest("GET", `${routePrefix}${suffix}`)).toBe(true);
    },
  );
});
