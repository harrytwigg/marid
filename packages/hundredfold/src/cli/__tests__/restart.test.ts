import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-restart-test-"));
process.env.JINN_HOME = tmpHome;

const lifecycle = vi.hoisted(() => ({
  assertPortTakeoverAllowed: vi.fn(),
  restartDetached: vi.fn(),
}));
const restartRequest = vi.hoisted(() => ({
  requestRestartFromGateway: vi.fn(async () => true),
}));

vi.mock("../../gateway/lifecycle.js", () => lifecycle);
vi.mock("../restart-request.js", () => restartRequest);
const loaded = vi.hoisted(() => ({ config: { gateway: { host: "127.0.0.1", port: 21877 }, engines: { default: "claude" } } as Record<string, unknown> }));
vi.mock("../../shared/config.js", () => ({
  loadConfig: () => loaded.config,
}));

const { runRestart } = await import("../restart.js");
const { resetOpencodeAccountKeysForTest, setOpencodeAccountKeyEnv } = await import("../../shared/child-env.js");

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(tmpHome, { recursive: true });
});

describe("runRestart", () => {
  it("asks the running gateway to spawn the restart helper", async () => {
    await runRestart();

    expect(restartRequest.requestRestartFromGateway).toHaveBeenCalledTimes(1);
    expect(restartRequest.requestRestartFromGateway).toHaveBeenCalledWith(fetch, { port: 21877 });
    expect(lifecycle.restartDetached).not.toHaveBeenCalled();
  });

  it("falls back to the detached helper when the gateway request is unavailable", async () => {
    restartRequest.requestRestartFromGateway.mockResolvedValueOnce(false);

    await runRestart();

    expect(lifecycle.restartDetached).toHaveBeenCalledTimes(1);
  });

  it("passes --take-port to the detached helper when explicitly requested", async () => {
    restartRequest.requestRestartFromGateway.mockResolvedValueOnce(false);

    await runRestart({ takePort: true });

    expect(lifecycle.restartDetached).toHaveBeenCalledWith({ takePort: true, port: 21877 });
  });

  describe("account keys", () => {
    const withAccount = (): void => {
      loaded.config = {
        gateway: { host: "127.0.0.1", port: 21877 },
        engines: { default: "claude", opencode: { accounts: { acme: { provider: "acme-go", base: "opencode-go", keyEnv: "ACME_RESTART_KEY" } } } },
      };
    };

    afterEach(() => {
      loaded.config = { gateway: { host: "127.0.0.1", port: 21877 }, engines: { default: "claude" } };
      resetOpencodeAccountKeysForTest();
    });

    it("warns, before the detached restart, that a declared account's key is in neither the vault nor the environment", async () => {
      withAccount();
      restartRequest.requestRestartFromGateway.mockResolvedValueOnce(false);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await runRestart();
        const text = errors.mock.calls.map((call) => String(call[0])).join("\n");
        expect(text).toContain("acme (ACME_RESTART_KEY)");
        expect(text).toContain("will run without it");
        expect(text).toContain("POST /api/system/restart");
        expect(lifecycle.restartDetached).toHaveBeenCalledTimes(1);
      } finally {
        errors.mockRestore();
      }
    });

    it("stays quiet when the key is in the vault, and when the running gateway does the restart", async () => {
      withAccount();
      process.env.ACME_RESTART_KEY = "sk-restart";
      setOpencodeAccountKeyEnv(["ACME_RESTART_KEY"]);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        restartRequest.requestRestartFromGateway.mockResolvedValueOnce(false);
        await runRestart();
        await runRestart();
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });
  });
});
