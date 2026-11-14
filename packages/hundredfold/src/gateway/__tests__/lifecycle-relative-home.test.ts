import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalCwd = process.cwd();
const originalHome = process.env.HUNDREDFOLD_HOME;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-relative-home-root-"));
const home = path.join(root, "home");
fs.mkdirSync(home, { recursive: true });

process.chdir(root);
process.env.HUNDREDFOLD_HOME = "home";
const publicHome = path.resolve("home");

const { buildGatewayChildEnv } = await import("../lifecycle.js");
const { resetOpencodeAccountKeysForTest, setOpencodeAccountKeyEnv } = await import("../../shared/child-env.js");

afterAll(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HUNDREDFOLD_HOME;
  else process.env.HUNDREDFOLD_HOME = originalHome;
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

describe("gateway child HUNDREDFOLD_HOME identity", () => {
  it("exports the public absolute HUNDREDFOLD_HOME plus a canonical identity when the starter used a relative home", () => {
    const env = buildGatewayChildEnv({
      gateway: { port: 7851, host: "127.0.0.1" },
      engines: { default: "claude" },
    } as any);

    expect(env.HUNDREDFOLD_HOME).toBe(publicHome);
    expect(env.HUNDREDFOLD_HOME).not.toBe("home");
    expect(env.HUNDREDFOLD_HOME_IDENTITY).toBe(fs.realpathSync.native(home));
  });

  it("hands the successor gateway the account keys this one took out of its own environment", () => {
    process.env.ACME_SUCCESSOR_KEY = "sk-successor";
    setOpencodeAccountKeyEnv(["ACME_SUCCESSOR_KEY"]);
    try {
      expect(process.env.ACME_SUCCESSOR_KEY).toBeUndefined();
      const env = buildGatewayChildEnv({ gateway: { port: 7851, host: "127.0.0.1" }, engines: { default: "claude" } } as any);
      expect(env.ACME_SUCCESSOR_KEY).toBe("sk-successor");
    } finally {
      resetOpencodeAccountKeysForTest();
      delete process.env.ACME_SUCCESSOR_KEY;
    }
  });

  it("does not hand the successor the key of an account a reload removed", () => {
    process.env.ACME_SUCCESSOR_KEY_B = "sk-b";
    process.env.ACME_SUCCESSOR_KEY_C = "sk-c";
    setOpencodeAccountKeyEnv(["ACME_SUCCESSOR_KEY_B", "ACME_SUCCESSOR_KEY_C"]);
    setOpencodeAccountKeyEnv(["ACME_SUCCESSOR_KEY_B"]);
    try {
      const env = buildGatewayChildEnv({ gateway: { port: 7851, host: "127.0.0.1" }, engines: { default: "claude" } } as any);
      expect(env.ACME_SUCCESSOR_KEY_B).toBe("sk-b");
      expect(env.ACME_SUCCESSOR_KEY_C).toBeUndefined();
    } finally {
      resetOpencodeAccountKeysForTest();
      delete process.env.ACME_SUCCESSOR_KEY_B;
      delete process.env.ACME_SUCCESSOR_KEY_C;
    }
  });
});
