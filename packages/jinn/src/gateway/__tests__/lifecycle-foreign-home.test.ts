import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Point JINN_HOME at a temp dir BEFORE importing the module under test so
// PID_FILE resolves inside it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-lifecycle-foreign-"));
process.env.JINN_HOME = tmpHome;
fs.writeFileSync(path.join(tmpHome, "config.yaml"), `
gateway:
  host: 127.0.0.1
  port: 7799
engines:
  default: claude
  claude: {}
`);

const { assertPortTakeoverAllowed, getStatus, portOwnedByThisInstance, stop } = await import("../lifecycle.js");
const { PID_FILE, GATEWAY_INFO_FILE, JINN_HOME_IDENTITY } = await import("../../shared/paths.js");
const { pidBelongsToAnotherHome, reapableGatewayPids } = await import("../process-home.js");
const { readGatewayInfo, writeGatewayInfo } = await import("../gateway-info.js");

const itNeedsProcessEnvReads = it.skipIf(process.platform === "win32");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function waitForListening(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listening = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (listening) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`nothing listened on ${port}`);
}

/** A process listening on `port` whose environment names `jinnHome` — or, with none, no
 *  home at all, as a gateway started in the foreground from a plain shell. */
function spawnListeningGatewayChild(port: number, opts: { jinnHome?: string }): ChildProcess {
  const env = { ...process.env };
  delete env.JINN_HOME;
  delete env.JINN_HOME_IDENTITY;
  if (opts.jinnHome) env.JINN_HOME = opts.jinnHome;
  return spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000);`], {
    stdio: "ignore",
    env,
  });
}

/** A gateway-looking process (its script is named daemon-entry.js) that belongs to `jinnHome`. */
function spawnDaemonLookalike(port: number, jinnHome: string, scriptDir: string): ChildProcess {
  const script = path.join(scriptDir, "daemon-entry.js");
  fs.writeFileSync(script, `require("node:net").createServer().listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000);`);
  return spawn(process.execPath, [script], {
    stdio: "ignore",
    env: { ...process.env, JINN_HOME: jinnHome, JINN_HOME_IDENTITY: fs.realpathSync.native(jinnHome) },
  });
}

/**
 * A second home beside a running instance — a throwaway made by copying the live home,
 * PID file and all, or one left on the live port — must never act on that instance.
 */
describe("a home that shares a machine with another instance", () => {
  const children: ChildProcess[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child);
      }
    }
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(PID_FILE, { force: true });
    fs.rmSync(GATEWAY_INFO_FILE, { force: true });
  });

  async function foreignGateway(): Promise<{ child: ChildProcess; port: number }> {
    const foreignHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-foreign-home-"));
    tempDirs.push(foreignHome);
    const port = await freePort();
    const child = spawnDaemonLookalike(port, foreignHome, foreignHome);
    children.push(child);
    await waitForSpawn(child);
    await waitForListening(port);
    return { child, port };
  }

  itNeedsProcessEnvReads("never stops a copied PID file's foreign gateway, even with --take-port", async () => {
    const { child } = await foreignGateway();
    fs.writeFileSync(PID_FILE, String(child.pid));

    expect(stop(await freePort(), { takePort: true })).toBe(false);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  itNeedsProcessEnvReads("recognises a pid recorded in a copied gateway.json as another instance's", async () => {
    const { child } = await foreignGateway();
    const port = await freePort();
    const own = spawnListeningGatewayChild(port, { jinnHome: tmpHome });
    children.push(own);
    await waitForSpawn(own);

    expect(pidBelongsToAnotherHome(child.pid!)).toBe(true);
    expect(pidBelongsToAnotherHome(own.pid!)).toBe(false);
  });

  itNeedsProcessEnvReads("checks status on the port it is given, not the configured one", async () => {
    const port = await freePort();
    const child = spawnListeningGatewayChild(port, { jinnHome: tmpHome });
    children.push(child);
    await waitForSpawn(child);
    await waitForListening(port);

    expect(getStatus(port)).toEqual({ running: true, pid: child.pid });
  });

  itNeedsProcessEnvReads("attributes a port's listener to this home only when it is this home's", async () => {
    const { port: foreignPort } = await foreignGateway();
    const ownPort = await freePort();
    const own = spawnListeningGatewayChild(ownPort, { jinnHome: tmpHome });
    children.push(own);
    await waitForSpawn(own);
    await waitForListening(ownPort);

    expect(portOwnedByThisInstance(ownPort)).toBe(true);
    expect(portOwnedByThisInstance(foreignPort)).toBe(false);
    expect(portOwnedByThisInstance(await freePort())).toBe(false);
  });

  /** A foreground gateway, which carries no home in its environment, and this home's
   *  gateway.json saying `home` wrote it — a copy of that gateway's home when `home`
   *  is another one. */
  async function foregroundGateway(home: string | undefined): Promise<{ child: ChildProcess; port: number }> {
    const port = await freePort();
    const child = spawnListeningGatewayChild(port, {});
    children.push(child);
    await waitForSpawn(child);
    await waitForListening(port);
    fs.writeFileSync(GATEWAY_INFO_FILE, JSON.stringify({
      port, host: "127.0.0.1", pid: child.pid, secret: "s", token: "live-token", ...(home ? { home } : {}),
    }));
    return { child, port };
  }

  itNeedsProcessEnvReads("does not take a copied gateway.json as proof a foreground gateway is ours", async () => {
    const { child, port } = await foregroundGateway("/elsewhere/live-home");

    expect(portOwnedByThisInstance(port)).toBe(false);
    expect(() => assertPortTakeoverAllowed(port)).toThrow("owned by another jinn instance (JINN_HOME=/elsewhere/live-home)");
    expect(() => stop(port)).toThrow(/owned by another jinn instance/);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
  });

  itNeedsProcessEnvReads("still recognises this home's own foreground gateway by its gateway.json", async () => {
    const { port } = await foregroundGateway(JINN_HOME_IDENTITY);

    expect(portOwnedByThisInstance(port)).toBe(true);
  });

  itNeedsProcessEnvReads("keeps trusting a gateway.json written before homes were recorded", async () => {
    const { port } = await foregroundGateway(undefined);

    expect(portOwnedByThisInstance(port)).toBe(true);
  });
});

describe("reapableGatewayPids", () => {
  const children: ChildProcess[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function sleeper(jinnHome?: string): Promise<number> {
    const child = spawnListeningGatewayChild(await freePort(), { jinnHome });
    children.push(child);
    await waitForSpawn(child);
    return child.pid!;
  }

  itNeedsProcessEnvReads("reaps nothing from a gateway.json another home wrote, even a foreground gateway's", async () => {
    const live = await sleeper(undefined);
    const session = await sleeper(undefined);

    expect(reapableGatewayPids({ pid: live, ptyPids: [session], home: "/elsewhere/live-home" }, JINN_HOME_IDENTITY)).toEqual([]);
  });

  itNeedsProcessEnvReads("reaps this home's orphans and skips any pid whose environment names another home", async () => {
    const foreignHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-foreign-home-"));
    tempDirs.push(foreignHome);
    const ownOrphan = await sleeper(tmpHome);
    const foreign = await sleeper(foreignHome);
    const previousGateway = await sleeper(undefined);

    expect(reapableGatewayPids({ pid: previousGateway, ptyPids: [ownOrphan, foreign], home: JINN_HOME_IDENTITY }, JINN_HOME_IDENTITY))
      .toEqual([ownOrphan, previousGateway]);
    expect(reapableGatewayPids({ pid: previousGateway, ptyPids: [ownOrphan, foreign] }, JINN_HOME_IDENTITY))
      .toEqual([ownOrphan, previousGateway]);
  });
});

describe("writeGatewayInfo", () => {
  it("records the home that wrote it, and later pid updates keep it", () => {
    const file = path.join(tmpHome, "gateway-info-home.json");
    writeGatewayInfo(file, { port: 7900, pid: process.pid, home: JINN_HOME_IDENTITY });

    expect(readGatewayInfo(file)?.home).toBe(JINN_HOME_IDENTITY);
    fs.rmSync(file, { force: true });
  });
});
