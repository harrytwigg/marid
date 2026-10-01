import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  setup: vi.fn(async (_opts: unknown) => undefined),
  start: vi.fn(async (_opts: unknown) => ({ port: process.env.JINN_PORT, url: process.env.JINN_GATEWAY_URL })),
}));
vi.mock("../../shared/runtime-guard.js", () => ({
  assertNativeRuntime: vi.fn(),
  repairNodePtySpawnHelper: vi.fn(),
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-setup-port-"));
const previous = { ...process.env };
process.env.JINN_INSTANCES_REGISTRY = path.join(root, "instances.json");
fs.mkdirSync(process.env.JINN_HOME!, { recursive: true });

const { CONFIG_PATH, GATEWAY_INFO_FILE } = await import("../../shared/paths.js");
const { settleGatewayPort } = await import("../setup-port.js");

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  fs.rmSync(root, { recursive: true, force: true });
});

const SEED = `jinn:
  version: "1.0.0"

gateway:
  port: 7799
  host: "127.0.0.1"
  authRequired: true
engines:
  default: claude
  claude:
    bin: claude
    model: opus
`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe("jinn setup --port", () => {
  let program: import("commander").Command;

  beforeAll(async () => {
    vi.doMock("../setup.js", () => ({ runSetup: handlers.setup }));
    vi.doMock("../start.js", () => ({ runStart: handlers.start }));
    const { buildProgram } = await import("../../../bin/jinn.js");
    program = buildProgram();
    program.exitOverride();
    for (const command of program.commands) command.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  });

  beforeEach(() => {
    handlers.setup.mockClear();
    handlers.start.mockClear();
  });

  it("hands the requested port to setup", async () => {
    await program.parseAsync(["node", "jinn", "setup", "--port", "7801"]);

    expect(handlers.setup).toHaveBeenCalledWith(expect.objectContaining({ port: 7801 }));
  });

  it.each(["abc", "0", "65536", "78o1", "7801.5"])("rejects --port %s rather than seeding the default", async (value) => {
    await expect(program.parseAsync(["node", "jinn", "setup", "--port", value])).rejects.toThrow(/port number/);
    expect(handlers.setup).not.toHaveBeenCalled();
  });

  it("keeps a port given explicitly for the other home", async () => {
    const liveHome = path.join(root, "live");
    const throwaway = path.join(root, "throwaway-explicit");
    Object.assign(process.env, {
      JINN_HOME: throwaway,
      JINN_BINDING_HOME: liveHome,
      JINN_HOST: "127.0.0.1",
      JINN_PORT: "7802",
      JINN_GATEWAY_URL: "http://127.0.0.1:7790",
      JINN_GATEWAY_TOKEN: "live-gateway-token",
    });

    await program.parseAsync(["node", "jinn", "start", "--daemon"]);

    expect(await handlers.start.mock.results[0].value).toEqual({ port: "7802", url: undefined });
    expect(process.env.JINN_GATEWAY_TOKEN).toBeUndefined();
    delete process.env.JINN_PORT;
  });

  it("does not let a live session's port follow a command aimed at another home", async () => {
    const liveHome = path.join(root, "live");
    const throwaway = path.join(root, "throwaway");
    fs.mkdirSync(liveHome, { recursive: true });
    fs.mkdirSync(throwaway, { recursive: true });
    Object.assign(process.env, {
      JINN_HOME: throwaway,
      JINN_BINDING_HOME: liveHome,
      JINN_HOST: "127.0.0.1",
      JINN_PORT: "7790",
      JINN_GATEWAY_URL: "http://127.0.0.1:7790",
      JINN_GATEWAY_TOKEN: "live-gateway-token",
      JINN_SESSION_ID: "live-session",
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    let notice: string[];
    try {
      await program.parseAsync(["node", "jinn", "start", "--daemon"]);
      notice = stderr.mock.calls.map((call) => String(call[0]));
    } finally {
      stderr.mockRestore();
    }

    expect(handlers.start).toHaveBeenCalledOnce();
    expect(await handlers.start.mock.results[0].value).toEqual({ port: undefined, url: undefined });
    expect(process.env.JINN_HOME).toBe(throwaway);
    expect(process.env.JINN_GATEWAY_TOKEN).toBeUndefined();
    expect(process.env.JINN_SESSION_ID).toBeUndefined();
    expect(notice).toEqual([expect.stringContaining(`Ignoring JINN_PORT=7790: it is the port of the instance at ${liveHome}`)]);
  });
});

describe("settleGatewayPort", () => {
  const lines: string[] = [];
  const report = {
    ok: (message: string) => lines.push(message),
    warn: (message: string) => lines.push(message),
    info: (message: string) => lines.push(message),
  };

  beforeEach(() => {
    fs.writeFileSync(CONFIG_PATH, SEED);
    delete process.env.JINN_PORT;
    lines.length = 0;
  });

  afterEach(() => {
    delete process.env.JINN_PORT;
  });

  const printed = () => lines.join("\n");

  it("records an explicit port in the new home's config.yaml and keeps the rest of it", async () => {
    const port = await freePort();

    await settleGatewayPort(port, { report });

    const written = fs.readFileSync(CONFIG_PATH, "utf-8");
    expect(written).toContain(`port: ${port}`);
    expect(written).not.toContain("port: 7799");
    expect(written).toContain("authRequired: true");
    expect(written).toContain("model: opus");
    expect(printed()).toContain(`Gateway port ${port} recorded`);
  });

  it("re-points an existing home when asked explicitly", async () => {
    const first = await freePort();
    await settleGatewayPort(first, { report });
    const second = await freePort();

    await settleGatewayPort(second, { report });

    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toContain(`port: ${second}`);
  });

  it("records JINN_PORT as the port of a home it is creating", async () => {
    const port = await freePort();
    process.env.JINN_PORT = String(port);

    await settleGatewayPort(undefined, { fresh: true, report });

    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toContain(`port: ${port}`);
    expect(printed()).toContain(`Gateway port ${port} (from JINN_PORT) recorded`);
  });

  it("never saves a container's published JINN_PORT", async () => {
    process.env.JINN_PORT = "8080";
    process.env.JINN_CONTAINER = "1";

    try {
      await settleGatewayPort(undefined, { fresh: true, report });
    } finally {
      delete process.env.JINN_CONTAINER;
    }

    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe(SEED);
    expect(printed()).not.toContain("JINN_PORT=8080");
  });

  it("says JINN_PORT is not saved over an existing home's port, instead of silently ignoring it", async () => {
    process.env.JINN_PORT = "7801";

    await settleGatewayPort(undefined, { fresh: false, report });

    expect(fs.readFileSync(CONFIG_PATH, "utf-8")).toBe(SEED);
    expect(printed()).toContain("JINN_PORT=7801 only applies to processes that carry it");
    expect(printed()).toContain("jinn setup --port 7801");
  });

  it("warns when the configured port is already taken on this machine", async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", () => resolve()));
    const address = holder.address();
    const busy = typeof address === "object" && address ? address.port : 0;

    try {
      await settleGatewayPort(busy, { report });
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }

    expect(printed()).toContain(`Port ${busy} is already in use on this machine`);
  });

  it("still warns for a home copied from the instance holding the port", async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", () => resolve()));
    const address = holder.address();
    const busy = typeof address === "object" && address ? address.port : 0;
    // The copied record names a live pid and the busy port, but another home wrote it.
    fs.writeFileSync(GATEWAY_INFO_FILE, JSON.stringify({ port: busy, pid: process.pid, secret: "s", home: "/elsewhere/live-home" }));

    try {
      await settleGatewayPort(busy, { report });
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
      fs.rmSync(GATEWAY_INFO_FILE, { force: true });
    }

    expect(printed()).toContain(`Port ${busy} is already in use on this machine`);
  });
});
