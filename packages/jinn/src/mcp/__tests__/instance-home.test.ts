import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The MCP stdio server must follow the ACTIVE instance's home.
 *
 * `resolveServerToken()` and `managedRoots()` each open-coded a home rule that
 * hardcoded the default `.jinn` and ignored JINN_INSTANCE. Both live in the MCP
 * child, which is exactly where the fallback fires: engines spawn stdio servers
 * with a clean env, and `mcp/server-entry.ts` sets JINN_HOME only conditionally.
 * Under a non-default instance the server therefore read ANOTHER instance's
 * gateway token and sandboxed the file tools to another instance's directories.
 */

const ENV_KEYS = ["HOME", "USERPROFILE", "JINN_HOME", "JINN_INSTANCE"] as const;

/**
 * Point os.homedir() at a scratch root holding both the fixture instance home
 * and a `.jinn` decoy, with JINN_HOME unset. A resolver that hardcodes the
 * default lands on the decoy; the correct one lands on the fixture.
 *
 * os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows, so both are
 * redirected — setting only HOME left the real home in play on Windows.
 */
function withInstanceHome(instance: string): { root: string; instanceHome: string; decoyHome: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-instance-home-"));
  const instanceHome = path.join(root, `.${instance}`);
  const decoyHome = path.join(root, ".jinn");
  fs.mkdirSync(instanceHome, { recursive: true });
  fs.mkdirSync(decoyHome, { recursive: true });
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  delete process.env.JINN_HOME;
  process.env.JINN_INSTANCE = instance;
  return { root, instanceHome, decoyHome };
}

describe("MCP home resolution follows JINN_INSTANCE", () => {
  const envBackup: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
  const scratchRoots: string[] = [];

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (envBackup[key] === undefined) delete process.env[key];
      else process.env[key] = envBackup[key];
    }
    vi.resetModules();
    for (const root of scratchRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolveServerToken() reads ~/.<instance>/gateway.json, not ~/.jinn/gateway.json", async () => {
    const { root, instanceHome, decoyHome } = withInstanceHome("qafoo");
    scratchRoots.push(root);
    const instanceToken = "i".repeat(40);
    fs.writeFileSync(path.join(instanceHome, "gateway.json"), JSON.stringify({ token: instanceToken }));
    fs.writeFileSync(path.join(decoyHome, "gateway.json"), JSON.stringify({ token: "w".repeat(40) }));

    // Fresh import under the target env: shared/paths bakes its constants at
    // import time, so the eager graph has to be rebuilt to probe honestly.
    vi.resetModules();
    const { resolveServerToken } = await import("../server.js");

    expect(resolveServerToken()).toBe(instanceToken);
  });

  it("managedRoots() sandboxes files/uploads under ~/.<instance>, not ~/.jinn", async () => {
    const { root, instanceHome } = withInstanceHome("qafoo");
    scratchRoots.push(root);

    vi.resetModules();
    const { managedRoots } = await import("../file-tools.js");

    expect(managedRoots()).toEqual({
      home: instanceHome,
      filesDir: path.join(instanceHome, "files"),
      uploadsDir: path.join(instanceHome, "uploads"),
    });
  });

  it("an explicit JINN_HOME still wins over the instance default", async () => {
    const { root } = withInstanceHome("qafoo");
    scratchRoots.push(root);
    const explicit = path.join(root, "explicit-home");
    fs.mkdirSync(explicit, { recursive: true });
    process.env.JINN_HOME = explicit;

    vi.resetModules();
    const { managedRoots } = await import("../file-tools.js");

    expect(managedRoots().home).toBe(explicit);
  });
});
