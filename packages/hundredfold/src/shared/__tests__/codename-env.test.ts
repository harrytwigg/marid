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
import { OLD } from "../legacy/names.js";

const acme = namesFor("acme");
const same = namesFor(OLD.codename);

describe("environment names", () => {
  it("builds each name under the current prefix, with the legacy one second", () => {
    expect(envName("HOME", acme)).toBe("ACME_HOME");
    expect(envAliases("HOME", acme)).toEqual(["ACME_HOME", `${OLD.upper}_HOME`]);
    expect(envNamesFor(["HOME", "PORT"], acme)).toEqual(["ACME_HOME", `${OLD.upper}_HOME`, "ACME_PORT", `${OLD.upper}_PORT`]);
    expect(envAliases("HOME", same)).toEqual([`${OLD.upper}_HOME`]);
  });

  it("reads the current name first and falls back to the legacy one", () => {
    expect(readEnv({ [`${OLD.upper}_HOME`]: "/old" }, "HOME", acme)).toBe("/old");
    expect(readEnv({ [`${OLD.upper}_HOME`]: "/old", ACME_HOME: "/new" }, "HOME", acme)).toBe("/new");
    expect(readEnv({}, "HOME", acme)).toBeUndefined();
  });

  it("keeps an empty current value rather than skipping to the legacy one", () => {
    expect(readEnv({ ACME_HOME: "", [`${OLD.upper}_HOME`]: "/old" }, "HOME", acme)).toBe("");
  });

  it("sets every spelling so a child that has not adopted agrees", () => {
    const env: NodeJS.ProcessEnv = {};
    setEnv(env, "HOME", "/h", acme);
    expect(env).toEqual({ ACME_HOME: "/h", [`${OLD.upper}_HOME`]: "/h" });
    const unchanged: NodeJS.ProcessEnv = {};
    setEnv(unchanged, "HOME", "/h", same);
    expect(unchanged).toEqual({ [`${OLD.upper}_HOME`]: "/h" });
  });

  it("recognises the program's variables under either prefix, including the container entry's underscore form", () => {
    for (const key of [`${OLD.upper}_HOME`, "ACME_PORT", `_${OLD.upper}_CONTAINER_SERVICE_START`, "_ACME_X"]) expect(isCodenameEnvKey(key, acme)).toBe(true);
    for (const key of ["HOME", `${OLD.upper}Y`, "CLAUDE_CONFIG_DIR", "ACMEX_Y"]) expect(isCodenameEnvKey(key, acme)).toBe(false);
  });
});

describe("adoptLegacyEnv", () => {
  const collect = () => {
    const lines: string[] = [];
    return { lines, warn: (m: string) => lines.push(m), warned: new Set<string>() };
  };

  it("copies a legacy variable onto the current name and warns once per name", () => {
    const env: NodeJS.ProcessEnv = { [`${OLD.upper}_HOME`]: "/old", [`${OLD.upper}_PORT`]: "7000", PATH: "/bin" };
    const sink = collect();
    expect(adoptLegacyEnv(env, { names: acme, ...sink }).sort()).toEqual([`${OLD.upper}_HOME`, `${OLD.upper}_PORT`]);
    expect(env).toEqual({ [`${OLD.upper}_HOME`]: "/old", [`${OLD.upper}_PORT`]: "7000", ACME_HOME: "/old", ACME_PORT: "7000", PATH: "/bin" });
    expect(sink.lines).toEqual([
      `Environment variable ${OLD.upper}_HOME is deprecated: set ACME_HOME instead.`,
      `Environment variable ${OLD.upper}_PORT is deprecated: set ACME_PORT instead.`,
    ]);
    adoptLegacyEnv(env, { names: acme, ...sink });
    expect(sink.lines).toHaveLength(2);
  });

  it("never overwrites a variable set under the current name, and says nothing about one the gateway exported under both", () => {
    const env: NodeJS.ProcessEnv = { [`${OLD.upper}_HOME`]: "/old", ACME_HOME: "/new" };
    const sink = collect();
    expect(adoptLegacyEnv(env, { names: acme, ...sink })).toEqual([]);
    expect(env.ACME_HOME).toBe("/new");
    expect(sink.lines).toEqual([]);
  });

  it("adopts the per-session variables the gateway sets under the old name alone, without a warning", () => {
    const env: NodeJS.ProcessEnv = { [`${OLD.upper}_SESSION_ID`]: "s1", [`${OLD.upper}_SESSION_CAPABILITY`]: "c", [`${OLD.upper}_EMPLOYEE`]: "e", [`${OLD.upper}_DEPARTMENT`]: "d", [`${OLD.upper}_OPENCODE_COMMAND_TIMEOUT_MS`]: "900000", [`${OLD.upper}_PORT`]: "7" };
    const sink = collect();
    adoptLegacyEnv(env, { names: acme, ...sink });
    expect([env.ACME_SESSION_ID, env.ACME_SESSION_CAPABILITY, env.ACME_EMPLOYEE, env.ACME_DEPARTMENT, env.ACME_OPENCODE_COMMAND_TIMEOUT_MS]).toEqual(["s1", "c", "e", "d", "900000"]);
    expect(sink.lines).toEqual([`Environment variable ${OLD.upper}_PORT is deprecated: set ACME_PORT instead.`]);
  });

  it("adopts the container entry's underscore-led variable under its own form", () => {
    const env: NodeJS.ProcessEnv = { [`_${OLD.upper}_CONTAINER_SERVICE_START`]: "1" };
    adoptLegacyEnv(env, { names: acme, ...collect() });
    expect(env._ACME_CONTAINER_SERVICE_START).toBe("1");
  });

  it("does nothing while the codename is unchanged", () => {
    const env: NodeJS.ProcessEnv = { [`${OLD.upper}_HOME`]: "/old" };
    const sink = collect();
    expect(adoptLegacyEnv(env, { names: same, ...sink })).toEqual([]);
    expect(env).toEqual({ [`${OLD.upper}_HOME`]: "/old" });
    expect(sink.lines).toEqual([]);
  });
});
