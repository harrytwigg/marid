import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({ status: vi.fn(async () => undefined) }));
vi.mock("../status.js", () => ({ runStatus: handlers.status }));
vi.mock("../../shared/runtime-guard.js", () => ({
  assertNativeRuntime: vi.fn(),
  repairNodePtySpawnHelper: vi.fn(),
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-retarget-cli-"));
const sandboxHome = path.join(root, ".jinn-sandbox");
fs.mkdirSync(sandboxHome, { recursive: true });
fs.writeFileSync(
  path.join(root, "instances.json"),
  JSON.stringify([{ name: "jinn-sandbox", port: 7899, home: sandboxHome, createdAt: "2026-01-01T00:00:00.000Z" }]),
);

const previous = { ...process.env };
process.env.JINN_INSTANCES_REGISTRY = path.join(root, "instances.json");

const { buildProgram } = await import("../../../bin/jinn.js");
const program = buildProgram();

beforeAll(() => {
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
});

beforeEach(() => {
  handlers.status.mockClear();
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * `-i` points the process at another instance. The binding and credentials it
 * inherited describe the instance it is leaving, and every command downstream reads
 * them as if they described the target — how a sandbox `jinn pair` reached the live
 * gateway instead of the one it was pointed at.
 */
describe("jinn -i", () => {
  it("drops the leaving instance's binding and session before the command runs", async () => {
    process.env.JINN_HOME = path.join(root, ".jinn");
    process.env.JINN_INSTANCE = "jinn";
    process.env.JINN_HOST = "0.0.0.0";
    process.env.JINN_PORT = "7801";
    process.env.JINN_GATEWAY_URL = "http://127.0.0.1:7801";
    process.env.JINN_GATEWAY_TOKEN = "live-gateway-token";
    process.env.JINN_SESSION_ID = "live-session";

    await program.parseAsync(["node", "jinn", "-i", "sandbox", "status"]);

    expect(handlers.status).toHaveBeenCalledOnce();
    expect(process.env.JINN_HOME).toBe(sandboxHome);
    expect(process.env.JINN_INSTANCE).toBe("sandbox");
    expect(process.env.JINN_HOST).toBeUndefined();
    expect(process.env.JINN_PORT).toBeUndefined();
    expect(process.env.JINN_GATEWAY_URL).toBeUndefined();
    expect(process.env.JINN_GATEWAY_TOKEN).toBeUndefined();
    expect(process.env.JINN_SESSION_ID).toBeUndefined();
  });

  it("keeps the binding when it already names the targeted home", async () => {
    process.env.JINN_HOME = sandboxHome;
    process.env.JINN_INSTANCE = "jinn-sandbox";
    process.env.JINN_HOST = "0.0.0.0";
    process.env.JINN_PORT = "8080";

    await program.parseAsync(["node", "jinn", "-i", "sandbox", "status"]);

    expect(process.env.JINN_HOST).toBe("0.0.0.0");
    expect(process.env.JINN_PORT).toBe("8080");
  });
});
