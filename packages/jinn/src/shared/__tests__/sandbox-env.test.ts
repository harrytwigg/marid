import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JINN_INSTANCE_IDENTITY_ENV_KEYS,
  PRODUCTION_GATEWAY_PORTS,
  assertNotProductionGateway,
  buildSandboxChildEnv,
  dropForeignInstanceEnv,
  retargetInstanceEnv,
} from "../sandbox-env.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-sandbox-env-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

// A fabricated home directory, so "the default instance home" is a path under the temp
// root rather than the one this machine actually runs.
const defaultInstanceHome = path.join(scratch, "home", ".jinn");
beforeEach(() => {
  vi.spyOn(os, "homedir").mockReturnValue(path.join(scratch, "home"));
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Everything a CLI inherits when it is launched from inside a live gateway session. */
function liveSessionEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/agent",
    JINN_HOME: defaultInstanceHome,
    JINN_HOME_IDENTITY: defaultInstanceHome,
    JINN_INSTANCE: "jinn",
    JINN_HOST: "0.0.0.0",
    JINN_PORT: "7801",
    JINN_GATEWAY_URL: "http://127.0.0.1:7801",
    JINN_GATEWAY_TOKEN: "live-gateway-token",
    JINN_SESSION_ID: "live-session",
    JINN_SESSION_CAPABILITY: "live-capability",
    JINN_TAKE_PORT: "1",
    JINN_BINDING_HOME: defaultInstanceHome,
  };
}

describe("buildSandboxChildEnv", () => {
  it("carries no live instance identity into a throwaway child", () => {
    const home = path.join(scratch, "throwaway");

    const env = buildSandboxChildEnv({ home, port: 7899 }, liveSessionEnv());

    const survivors = JINN_INSTANCE_IDENTITY_ENV_KEYS
      .map((key) => ({ key, value: env[key] }))
      .filter(({ key, value }) => {
        if (value === undefined) return false;
        if (key === "JINN_HOME") return value !== home;
        if (key === "JINN_PORT") return value !== "7899";
        return true;
      });

    expect(survivors).toEqual([]);
  });

  it("passes unrelated variables through untouched", () => {
    const env = buildSandboxChildEnv({ home: path.join(scratch, "throwaway") }, liveSessionEnv());

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/agent");
  });

  it("names the target instance the child belongs to", () => {
    const home = path.join(scratch, "atlas");

    const env = buildSandboxChildEnv({
      home,
      instance: "atlas",
      host: "127.0.0.1",
      port: 7899,
      gatewayUrl: "http://127.0.0.1:7899",
      token: "throwaway-token",
    }, liveSessionEnv());

    expect(env).toMatchObject({
      JINN_HOME: home,
      JINN_INSTANCE: "atlas",
      JINN_HOST: "127.0.0.1",
      JINN_PORT: "7899",
      JINN_GATEWAY_URL: "http://127.0.0.1:7899",
      JINN_GATEWAY_TOKEN: "throwaway-token",
    });
  });
});

describe("assertNotProductionGateway", () => {
  it("names the ports a live gateway owns", () => {
    expect(PRODUCTION_GATEWAY_PORTS).toEqual([7777, 7788]); // footgun: ok pins the refusal set, so the cases below cannot pass against an empty list
  });

  it.each(PRODUCTION_GATEWAY_PORTS)("refuses the live gateway port %d", (port) => {
    expect(() => assertNotProductionGateway({ home: path.join(scratch, "throwaway"), port }))
      .toThrow(String(port));
  });

  it("refuses the default instance home", () => {
    expect(() => assertNotProductionGateway({ home: defaultInstanceHome }))
      .toThrow(new RegExp(defaultInstanceHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("allows a throwaway home on a throwaway port", () => {
    expect(() => assertNotProductionGateway({ home: path.join(scratch, "throwaway"), port: 7899 }))
      .not.toThrow();
  });
});

describe("retargetInstanceEnv", () => {
  it("drops the binding and credentials of the instance being left", () => {
    const env = liveSessionEnv();
    const home = path.join(scratch, "sandbox");

    retargetInstanceEnv({ home, instance: "sandbox" }, env);

    expect(env.JINN_HOME).toBe(home);
    expect(env.JINN_INSTANCE).toBe("sandbox");
    expect(env.JINN_PORT).toBeUndefined();
    expect(env.JINN_HOST).toBeUndefined();
    expect(env.JINN_GATEWAY_URL).toBeUndefined();
    expect(env.JINN_GATEWAY_TOKEN).toBeUndefined();
    expect(env.JINN_SESSION_ID).toBeUndefined();
  });

  it("keeps a binding that already describes the target home", () => {
    const home = path.join(scratch, "container-home");
    const env: NodeJS.ProcessEnv = { JINN_HOME: home, JINN_HOST: "0.0.0.0", JINN_PORT: "8080" };

    retargetInstanceEnv({ home, instance: "jinn" }, env);

    expect(env.JINN_HOST).toBe("0.0.0.0");
    expect(env.JINN_PORT).toBe("8080");
  });
});

describe("dropForeignInstanceEnv", () => {
  it("drops the binding and session a live session leaked into a command aimed at another home", () => {
    const home = path.join(scratch, "throwaway");
    const env: NodeJS.ProcessEnv = { ...liveSessionEnv(), JINN_HOME: home };

    const dropped = dropForeignInstanceEnv(env);

    expect(dropped).toEqual(expect.arrayContaining(["JINN_HOST", "JINN_PORT", "JINN_GATEWAY_TOKEN", "JINN_SESSION_ID", "JINN_BINDING_HOME"]));
    expect(dropped).not.toContain("JINN_HOME");
    expect(env.JINN_HOME).toBe(home);
    for (const key of JINN_INSTANCE_IDENTITY_ENV_KEYS) {
      if (key !== "JINN_HOME") expect(env[key], key).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("keeps a JINN_PORT set for this command, and only that", () => {
    const home = path.join(scratch, "throwaway");
    const env: NodeJS.ProcessEnv = { ...liveSessionEnv(), JINN_HOME: home, JINN_PORT: "7899" };

    const dropped = dropForeignInstanceEnv(env);

    expect(env.JINN_PORT).toBe("7899");
    expect(dropped).not.toContain("JINN_PORT");
    expect(env.JINN_HOST).toBeUndefined();
    expect(env.JINN_GATEWAY_TOKEN).toBeUndefined();
  });

  it("drops JINN_PORT when it cannot tell whose it is", () => {
    const home = path.join(scratch, "throwaway");
    const env: NodeJS.ProcessEnv = { ...liveSessionEnv(), JINN_HOME: home };
    delete env.JINN_GATEWAY_URL;

    expect(dropForeignInstanceEnv(env)).toContain("JINN_PORT");
    expect(env.JINN_PORT).toBeUndefined();
  });

  it("keeps the binding when the command targets the home it belongs to", () => {
    const env = liveSessionEnv();

    expect(dropForeignInstanceEnv(env)).toEqual([]);
    expect(env.JINN_PORT).toBe("7801");
    expect(env.JINN_GATEWAY_TOKEN).toBe("live-gateway-token");
  });

  it("keeps an explicit binding no gateway attributed to a home (a container's published port)", () => {
    const env: NodeJS.ProcessEnv = { JINN_HOME: path.join(scratch, "container-home"), JINN_HOST: "0.0.0.0", JINN_PORT: "8080" };

    expect(dropForeignInstanceEnv(env)).toEqual([]);
    expect(env.JINN_PORT).toBe("8080");
  });

  // Creating a symlink needs Developer Mode or elevation on Windows.
  it.skipIf(process.platform === "win32")("compares homes by identity, not spelling", () => {
    const real = path.join(scratch, "real-home");
    fs.mkdirSync(real, { recursive: true });
    const alias = path.join(scratch, "alias-home");
    fs.symlinkSync(real, alias);
    const env: NodeJS.ProcessEnv = { JINN_HOME: alias, JINN_PORT: "7802", JINN_BINDING_HOME: real };

    expect(dropForeignInstanceEnv(env)).toEqual([]);
    expect(env.JINN_PORT).toBe("7802");
  });
});
