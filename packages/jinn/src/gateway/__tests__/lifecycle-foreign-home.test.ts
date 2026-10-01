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
  port: 7777
engines:
  default: claude
  claude: {}
`);

const { getStatus, portOwnedByThisInstance, stop } = await import("../lifecycle.js");
const { PID_FILE, GATEWAY_INFO_FILE } = await import("../../shared/paths.js");
const { pidBelongsToAnotherHome } = await import("../process-home.js");

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

/** A process listening on `port` whose environment names `jinnHome`. */
function spawnListeningGatewayChild(port: number, opts: { jinnHome: string }): ChildProcess {
  return spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000);`], {
    stdio: "ignore",
    env: { ...process.env, JINN_HOME: opts.jinnHome },
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

  itNeedsProcessEnvReads("does not report a copied PID file's foreign gateway as this home's", async () => {
    const { child } = await foreignGateway();
    fs.writeFileSync(PID_FILE, String(child.pid));

    expect(getStatus(await freePort()).running).toBe(false);
  });

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
});
