import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanEnv, localOpencodeLaunch } from "../opencode-launch.js";
import type { EngineRunOpts } from "../../shared/types.js";

/**
 * The env the opencode engine hands its child.
 *
 * A gateway started from inside an opencode session — or restarted as that
 * session's child (`jinn restart`) — carries the parent's `OPENCODE_CONFIG`,
 * which names the OTHER session's staged MCP config, plus that server's
 * password and pid. `cleanEnv` has to drop them: a turn that stages no config
 * of its own must leave opencode's own config alone, not silently load a
 * sibling's. `vi.stubEnv` runs after vitest.setup's LEAKY_ENV_VARS scrub, so
 * these assertions observe the engine, not the test runner's env.
 */
const PARENT = {
  OPENCODE: "1",
  OPENCODE_CONFIG: "/parent/session/tmp/opencode.json",
  OPENCODE_PID: "4242",
  OPENCODE_SERVER_PASSWORD: "from-parent",
} as const;

function baseOpts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return {
    prompt: "build it",
    cwd: process.cwd(),
    sessionId: "sess-B",
    bin: "opencode",
    model: "opencode-go/deepseek-v4.1-flash",
    ...over,
  };
}

describe("cleanEnv — opencode's inherited session env", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("drops the parent session's config, password and pid, then stamps its own", () => {
    for (const [key, value] of Object.entries(PARENT)) vi.stubEnv(key, value);

    const env = cleanEnv("sess-B");

    for (const key of Object.keys(PARENT)) expect(env[key], key).toBeUndefined();
    expect(env.JINN_SESSION_ID).toBe("sess-B");
    // Set AFTER the scrub, so it survives.
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
  });

  it("keeps the operator's own OPENCODE_* settings", () => {
    vi.stubEnv("OPENCODE_CONFIG_DIR", "/home/me/.config/opencode");
    vi.stubEnv("OPENCODE_CONFIG", PARENT.OPENCODE_CONFIG);

    const env = cleanEnv("sess-B");

    expect(env.OPENCODE_CONFIG_DIR).toBe("/home/me/.config/opencode");
    expect(env.OPENCODE_CONFIG).toBeUndefined();
  });
});

describe("localOpencodeLaunch — a staged config wins over an inherited one", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("leaves OPENCODE_CONFIG unset for a session with no MCP servers", () => {
    vi.stubEnv("OPENCODE_CONFIG", PARENT.OPENCODE_CONFIG);

    expect(localOpencodeLaunch(baseOpts(), "sess-B").env.OPENCODE_CONFIG).toBeUndefined();
  });

  it("sets the session's own staged path when it has servers", () => {
    vi.stubEnv("OPENCODE_CONFIG", PARENT.OPENCODE_CONFIG);

    const plan = localOpencodeLaunch(
      baseOpts({ resolvedMcp: { mcpServers: { jinn: { command: "node", args: ["server.js"] } } } as never }),
      "sess-B",
    );

    expect(plan.configHandle?.staged).toBe(true);
    expect(plan.env.OPENCODE_CONFIG).toBe(plan.configHandle?.staged ? plan.configHandle.configPath : undefined);
    expect(plan.env.OPENCODE_CONFIG).not.toBe(PARENT.OPENCODE_CONFIG);
  });
});
