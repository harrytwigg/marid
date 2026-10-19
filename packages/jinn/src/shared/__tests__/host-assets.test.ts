import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { namesFor } from "../codename.js";
import { hostAssetStamp, readHostAsset, relayStampShellCheck, renderHostAsset } from "../host-assets.js";

const RELAY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "hook-relay.mjs");
const acme = namesFor("acme");
const same = namesFor("jinn");
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

describe("rendering the hook relay", () => {
  it("states the codename it was written for on its second line, after the shebang", () => {
    const lines = readHostAsset(RELAY, acme).split("\n");
    expect(lines[0]).toBe("#!/usr/bin/env node");
    expect(lines[1]).toBe(hostAssetStamp(acme));
    expect(lines[1]).toBe("// codename: acme");
  });

  it("leaves no placeholder behind", () => {
    expect(readHostAsset(RELAY, acme)).not.toContain("__CODENAME__");
    expect(renderHostAsset("a __CODENAME__ b __CODENAME__", acme)).toBe("a acme b acme");
  });
});

describe("the relay a rebuilt gateway writes, run against a gateway", () => {
  let dir: string;
  let server: http.Server;
  let received: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>;
  let port: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-"));
    received = [];
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        received.push({ headers: req.headers, body: JSON.parse(raw) });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    fs.writeFileSync(path.join(dir, "gateway.json"), JSON.stringify({ port, secret: "sek" }));
    fs.writeFileSync(path.join(dir, "relay.mjs"), readHostAsset(RELAY, acme));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const relay = (env: Record<string, string>): Promise<number | null> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(dir, "relay.mjs"), "sess-1"], { stdio: ["pipe", "ignore", "ignore"], env: { PATH: process.env.PATH ?? "", ...env } });
      child.on("error", reject);
      child.on("exit", resolve);
      child.stdin.end(JSON.stringify({ hook_event_name: "Stop" }));
    });

  it("finds the home under the new name and posts under the new names", async () => {
    expect(await relay({ ACME_HOME: dir })).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].headers["x-acme-hook-secret"]).toBe("sek");
    expect(received[0].body).toEqual({ acmeSessionId: "sess-1", hook: { hook_event_name: "Stop" } });
  });

  it("still finds the home a session started by the old gateway names", async () => {
    expect(await relay({ JINN_HOME: dir })).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].headers["x-acme-hook-secret"]).toBe("sek");
  });
});

describe("telling a stale relay from a current one on a remote host", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-stage-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const present = (check: string): string[] =>
    execFileSync("sh", ["-c", `root=${quote(root)}; for a in hook-relay.mjs remote-trust-seed.mjs; do if [ -f "$root/$a" ] && [ ! -L "$root/$a" ]${check}; then printf 'asset=%s\\n' "$a"; fi; done`], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean);

  it("counts a relay written for the old codename as missing, so it is staged again", () => {
    fs.writeFileSync(path.join(root, "hook-relay.mjs"), "#!/usr/bin/env node\n// codename: jinn\n");
    fs.writeFileSync(path.join(root, "remote-trust-seed.mjs"), "// seed\n");
    expect(present(relayStampShellCheck(quote, acme))).toEqual(["asset=remote-trust-seed.mjs"]);
    fs.writeFileSync(path.join(root, "hook-relay.mjs"), readHostAsset(RELAY, acme));
    expect(present(relayStampShellCheck(quote, acme))).toEqual(["asset=hook-relay.mjs", "asset=remote-trust-seed.mjs"]);
  });

  it("asks for nothing while the codename is unchanged, so every copy that exists is current", () => {
    expect(relayStampShellCheck(quote, same)).toBe("");
    fs.writeFileSync(path.join(root, "hook-relay.mjs"), "// relay\n");
    expect(present(relayStampShellCheck(quote, same))).toEqual(["asset=hook-relay.mjs"]);
  });
});
