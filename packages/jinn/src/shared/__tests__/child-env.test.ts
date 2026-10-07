import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildEngineChildEnv, isScopedSessionEnvName } from "../child-env.js";

describe("buildEngineChildEnv", () => {
  // The gateway resolves CLAUDE_CONFIG_DIR against its own cwd; the engine is spawned
  // in the session's working directory. A relative value handed through untouched
  // would name two different directories — seeded consent flags the engine cannot see,
  // transcripts the gateway never finds.
  it("resolves a relative CLAUDE_CONFIG_DIR so the child agrees with the gateway", () => {
    const env = buildEngineChildEnv({ CLAUDE_CONFIG_DIR: "claude-state" });
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.resolve("claude-state"));
  });

  it("leaves an absolute CLAUDE_CONFIG_DIR alone", () => {
    const absolute = path.resolve(path.join("/srv", "claude"));
    const env = buildEngineChildEnv({ CLAUDE_CONFIG_DIR: absolute });
    expect(env.CLAUDE_CONFIG_DIR).toBe(absolute);
  });

  it("does not invent the variable when it is unset", () => {
    const env = buildEngineChildEnv({ PATH: "/usr/bin" });
    expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
  });

  it("still scrubs the engine-private keys", () => {
    const env = buildEngineChildEnv(
      { JINN_HOME_IDENTITY: "x", JINN_TAKE_PORT: "1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", KEEP: "yes" },
      { scrubClaudeCode: true },
    );
    expect(env).toEqual({ KEEP: "yes" });
  });

  // An opencode employee session exports its own OPENCODE_CONFIG (the parent
  // session's staged MCP config), password and pid into every child. Without
  // this scrub an opencode engine spawned with no config of its own inherits
  // another session's — so the engine's "no servers, leave opencode's config
  // alone" contract is only true when nobody ran the parent from opencode.
  it("drops opencode's inherited session env only when asked, and only the exact names", () => {
    const base = {
      OPENCODE: "1",
      OPENCODE_CONFIG: "/parent/session/tmp/opencode.json",
      OPENCODE_PID: "4242",
      OPENCODE_SERVER_PASSWORD: "secret",
      // Operator settings, not session plumbing: these must survive the scrub.
      OPENCODE_CONFIG_DIR: "/home/me/.config/opencode",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      KEEP: "yes",
    };
    // Default: untouched, so a caller that does not opt in keeps everything.
    expect(buildEngineChildEnv(base).OPENCODE_CONFIG).toBe(base.OPENCODE_CONFIG);
    // Asked: the four session keys go; the operator's OPENCODE_* stay.
    expect(buildEngineChildEnv(base, { scrubOpencode: true })).toEqual({
      OPENCODE_CONFIG_DIR: base.OPENCODE_CONFIG_DIR,
      OPENCODE_DISABLE_AUTOUPDATE: base.OPENCODE_DISABLE_AUTOUPDATE,
      KEEP: "yes",
    });
  });
});

describe("buildEngineChildEnv for a department-scoped session", () => {
  const gateway = {
    PATH: "/usr/bin", HOME: "/home/op", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", XDG_RUNTIME_DIR: "/run/user/1",
    https_proxy: "http://proxy.invalid:3128", JINN_HOME: "/srv/instance", JINN_GATEWAY_URL: "http://127.0.0.1:1", JINN_BINDING_HOME: "/srv/instance",
    CLAUDE_CONFIG_DIR: "/home/op/.claude", ANTHROPIC_MODEL: "sonnet", DISABLE_TELEMETRY: "1",
    ALPHA_API_KEY: "alpha-secret", GITHUB_TOKEN: "github-secret", ANTHROPIC_API_KEY: "api-secret", NODE_OPTIONS: "--inspect",
  };

  it("keeps only the allow-list, dropping every other variable the gateway holds", () => {
    const env = buildEngineChildEnv(gateway, { scopedSession: true });
    expect(Object.keys(env).sort()).toEqual([
      "ANTHROPIC_MODEL", "CLAUDE_CONFIG_DIR", "DISABLE_TELEMETRY", "HOME", "JINN_BINDING_HOME", "JINN_GATEWAY_URL", "JINN_HOME",
      "LANG", "LC_ALL", "PATH", "XDG_RUNTIME_DIR", "https_proxy",
    ]);
  });

  it("leaves an unscoped session's environment whole", () => {
    expect(buildEngineChildEnv(gateway)).toEqual(gateway);
  });

  it("matches names case-insensitively, as Windows does", () => {
    expect(isScopedSessionEnvName("Path")).toBe(true);
    expect(isScopedSessionEnvName("SystemRoot")).toBe(true);
    expect(isScopedSessionEnvName("Alpha_Api_Key")).toBe(false);
  });
});
