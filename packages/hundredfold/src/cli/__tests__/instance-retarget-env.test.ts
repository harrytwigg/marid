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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-retarget-cli-"));
const sandboxHome = path.join(root, ".hundredfold-sandbox");
fs.mkdirSync(sandboxHome, { recursive: true });
fs.writeFileSync(
  path.join(root, "instances.json"),
  JSON.stringify([{ name: "hundredfold-sandbox", port: 7899, home: sandboxHome, createdAt: "2026-01-01T00:00:00.000Z" }]),
);

const previous = { ...process.env };
process.env.HUNDREDFOLD_INSTANCES_REGISTRY = path.join(root, "instances.json");

const { buildProgram } = await import("../../../bin/hundredfold.js");
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
 * them as if they described the target — how a sandbox `hundredfold pair` reached the live
 * gateway instead of the one it was pointed at.
 */
describe("hundredfold -i", () => {
  it("drops the leaving instance's binding and session before the command runs", async () => {
    process.env.HUNDREDFOLD_HOME = path.join(root, ".hundredfold");
    process.env.HUNDREDFOLD_INSTANCE = "hundredfold";
    process.env.HUNDREDFOLD_HOST = "0.0.0.0";
    process.env.HUNDREDFOLD_PORT = "7801";
    process.env.HUNDREDFOLD_GATEWAY_URL = "http://127.0.0.1:7801";
    process.env.HUNDREDFOLD_GATEWAY_TOKEN = "live-gateway-token";
    process.env.HUNDREDFOLD_SESSION_ID = "live-session";

    await program.parseAsync(["node", "hundredfold", "-i", "sandbox", "status"]);

    expect(handlers.status).toHaveBeenCalledOnce();
    expect(process.env.HUNDREDFOLD_HOME).toBe(sandboxHome);
    expect(process.env.HUNDREDFOLD_INSTANCE).toBe("sandbox");
    expect(process.env.HUNDREDFOLD_HOST).toBeUndefined();
    expect(process.env.HUNDREDFOLD_PORT).toBeUndefined();
    expect(process.env.HUNDREDFOLD_GATEWAY_URL).toBeUndefined();
    expect(process.env.HUNDREDFOLD_GATEWAY_TOKEN).toBeUndefined();
    expect(process.env.HUNDREDFOLD_SESSION_ID).toBeUndefined();
  });

  it("keeps the binding when it already names the targeted home", async () => {
    process.env.HUNDREDFOLD_HOME = sandboxHome;
    process.env.HUNDREDFOLD_INSTANCE = "hundredfold-sandbox";
    process.env.HUNDREDFOLD_HOST = "0.0.0.0";
    process.env.HUNDREDFOLD_PORT = "8080";

    await program.parseAsync(["node", "hundredfold", "-i", "sandbox", "status"]);

    expect(process.env.HUNDREDFOLD_HOST).toBe("0.0.0.0");
    expect(process.env.HUNDREDFOLD_PORT).toBe("8080");
  });
});
