import { describe, expect, it } from "vitest";
import { namesFor } from "../codename.js";
import {
  adoptLegacyEnv,
  envAliases,
  envName,
  envNamesFor,
  isCodenameEnvKey,
  readEnv,
  setEnv,
} from "../codename-env.js";

const acme = namesFor("acme");
const same = namesFor("jinn");

describe("environment names", () => {
  it("builds each name under the current prefix, with the legacy one second", () => {
    expect(envName("HOME", acme)).toBe("ACME_HOME");
    expect(envAliases("HOME", acme)).toEqual(["ACME_HOME", "JINN_HOME"]);
    expect(envNamesFor(["HOME", "PORT"], acme)).toEqual(["ACME_HOME", "JINN_HOME", "ACME_PORT", "JINN_PORT"]);
    expect(envAliases("HOME", same)).toEqual(["JINN_HOME"]);
  });

  it("reads the current name first and falls back to the legacy one", () => {
    expect(readEnv({ JINN_HOME: "/old" }, "HOME", acme)).toBe("/old");
    expect(readEnv({ JINN_HOME: "/old", ACME_HOME: "/new" }, "HOME", acme)).toBe("/new");
    expect(readEnv({}, "HOME", acme)).toBeUndefined();
  });

  it("keeps an empty current value rather than skipping to the legacy one", () => {
    expect(readEnv({ ACME_HOME: "", JINN_HOME: "/old" }, "HOME", acme)).toBe("");
  });

  it("sets every spelling so a child that has not adopted agrees", () => {
    const env: NodeJS.ProcessEnv = {};
    setEnv(env, "HOME", "/h", acme);
    expect(env).toEqual({ ACME_HOME: "/h", JINN_HOME: "/h" });
    const unchanged: NodeJS.ProcessEnv = {};
    setEnv(unchanged, "HOME", "/h", same);
    expect(unchanged).toEqual({ JINN_HOME: "/h" });
  });

  it("recognises the program's variables under either prefix, including the container entry's underscore form", () => {
    for (const key of ["JINN_HOME", "ACME_PORT", "_JINN_CONTAINER_SERVICE_START", "_ACME_X"]) expect(isCodenameEnvKey(key, acme)).toBe(true);
    for (const key of ["HOME", "JINNY", "CLAUDE_CONFIG_DIR", "ACMEX_Y"]) expect(isCodenameEnvKey(key, acme)).toBe(false);
  });
});

describe("adoptLegacyEnv", () => {
  const collect = () => {
    const lines: string[] = [];
    return { lines, warn: (m: string) => lines.push(m), warned: new Set<string>() };
  };

  it("copies a legacy variable onto the current name and warns once per name", () => {
    const env: NodeJS.ProcessEnv = { JINN_HOME: "/old", JINN_PORT: "7000", PATH: "/bin" };
    const sink = collect();
    expect(adoptLegacyEnv(env, { names: acme, ...sink }).sort()).toEqual(["JINN_HOME", "JINN_PORT"]);
    expect(env).toEqual({ JINN_HOME: "/old", JINN_PORT: "7000", ACME_HOME: "/old", ACME_PORT: "7000", PATH: "/bin" });
    expect(sink.lines).toEqual([
      "Environment variable JINN_HOME is deprecated: set ACME_HOME instead.",
      "Environment variable JINN_PORT is deprecated: set ACME_PORT instead.",
    ]);
    adoptLegacyEnv(env, { names: acme, ...sink });
    expect(sink.lines).toHaveLength(2);
  });

  it("never overwrites a variable set under the current name, and says nothing about one the gateway exported under both", () => {
    const env: NodeJS.ProcessEnv = { JINN_HOME: "/old", ACME_HOME: "/new" };
    const sink = collect();
    expect(adoptLegacyEnv(env, { names: acme, ...sink })).toEqual([]);
    expect(env.ACME_HOME).toBe("/new");
    expect(sink.lines).toEqual([]);
  });

  it("adopts the per-session variables the gateway sets under the old name alone, without a warning", () => {
    const env: NodeJS.ProcessEnv = { JINN_SESSION_ID: "s1", JINN_SESSION_CAPABILITY: "c", JINN_EMPLOYEE: "e", JINN_DEPARTMENT: "d", JINN_PORT: "7" };
    const sink = collect();
    adoptLegacyEnv(env, { names: acme, ...sink });
    expect([env.ACME_SESSION_ID, env.ACME_SESSION_CAPABILITY, env.ACME_EMPLOYEE, env.ACME_DEPARTMENT]).toEqual(["s1", "c", "e", "d"]);
    expect(sink.lines).toEqual(["Environment variable JINN_PORT is deprecated: set ACME_PORT instead."]);
  });

  it("adopts the container entry's underscore-led variable under its own form", () => {
    const env: NodeJS.ProcessEnv = { _JINN_CONTAINER_SERVICE_START: "1" };
    adoptLegacyEnv(env, { names: acme, ...collect() });
    expect(env._ACME_CONTAINER_SERVICE_START).toBe("1");
  });

  it("does nothing while the codename is unchanged", () => {
    const env: NodeJS.ProcessEnv = { JINN_HOME: "/old" };
    const sink = collect();
    expect(adoptLegacyEnv(env, { names: same, ...sink })).toEqual([]);
    expect(env).toEqual({ JINN_HOME: "/old" });
    expect(sink.lines).toEqual([]);
  });
});
