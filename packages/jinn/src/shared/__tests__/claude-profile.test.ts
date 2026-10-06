import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyClaudeProfileEnv,
  canonicalClaudeConfigDir,
  claudeJsonPathFor,
  claudeKeychainService,
  claudeProfileFromDir,
  claudeProfileKey,
  claudeProjectsDirFor,
  registerClaudeProfileDirs,
  resolveEmployeeClaudeProfile,
  validateEmployeeClaudeConfigDir,
} from "../claude-profile.js";
import { resetLocalProfileCheckForTests, verifyLocalClaudeProfile } from "../claude-profile-signin.js";
import { buildEngineChildEnv } from "../child-env.js";
import { assessFileRead } from "../file-read-policy.js";

let tmp: string;
let defaultDir: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-profile-")));
  defaultDir = path.join(tmp, "default-claude");
  fs.mkdirSync(defaultDir);
  vi.stubEnv("CLAUDE_CONFIG_DIR", defaultDir);
  resetLocalProfileCheckForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  registerClaudeProfileDirs(() => []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("canonicalClaudeConfigDir", () => {
  it("drops a trailing slash and . / .. segments, so one directory has one spelling", () => {
    expect(canonicalClaudeConfigDir("/Users/operator/.claude-friend/")).toBe("/Users/operator/.claude-friend");
    expect(canonicalClaudeConfigDir("/Users/operator/./x/../.claude-friend//")).toBe("/Users/operator/.claude-friend");
    expect(canonicalClaudeConfigDir("  /a/b  ")).toBe("/a/b");
    expect(canonicalClaudeConfigDir("/")).toBe("/");
  });

  it("normalises to NFC, as Claude Code does before hashing", () => {
    const decomposed = "/Users/operator/.claude-café";
    expect(canonicalClaudeConfigDir(decomposed)).toBe("/Users/operator/.claude-café");
  });
});

describe("claudeProfileKey", () => {
  it("is the first 8 hex of sha256 of the canonical string: Claude Code's Keychain suffix", () => {
    // Pinned value, computed independently with `printf '%s' <dir> | shasum -a 256`.
    expect(claudeProfileKey("/Users/operator/.claude-friend")).toBe("7c2aa2a9");
    expect(claudeProfileFromDir("/Users/operator/.claude-friend/")).toEqual({
      dir: "/Users/operator/.claude-friend",
      key: "7c2aa2a9",
    });
  });

  it("names the Keychain service, unsuffixed for the default profile", () => {
    expect(claudeKeychainService(null)).toBe("Claude Code-credentials");
    expect(claudeKeychainService(claudeProfileFromDir("/Users/operator/.claude-friend"))).toBe("Claude Code-credentials-7c2aa2a9");
  });
});

describe("profile paths", () => {
  it("keep today's values for the default profile and move inside a named one", () => {
    const named = claudeProfileFromDir("/Users/operator/.claude-friend");
    expect(claudeProjectsDirFor(null)).toBe(path.join(defaultDir, "projects"));
    expect(claudeJsonPathFor(null)).toBe(path.join(defaultDir, ".claude.json"));
    expect(claudeProjectsDirFor(named)).toBe("/Users/operator/.claude-friend/projects");
    expect(claudeJsonPathFor(named)).toBe("/Users/operator/.claude-friend/.claude.json");
  });
});

describe("validateEmployeeClaudeConfigDir (FR-050)", () => {
  const jinnHome = () => path.join(tmp, "home");

  it("accepts an unset field and an absolute directory outside the home", () => {
    expect(validateEmployeeClaudeConfigDir({}, jinnHome())).toBeUndefined();
    expect(validateEmployeeClaudeConfigDir({ claudeConfigDir: "/Users/operator/.claude-friend" }, jinnHome())).toBeUndefined();
  });

  it.each([
    ["a home-relative path", "~/.claude-friend", /not home-relative/],
    ["a relative path", "claude-friend", /must be an absolute path/],
    ["an empty value", "  ", /non-empty/],
  ])("refuses %s", (_label, value, message) => {
    expect(validateEmployeeClaudeConfigDir({ claudeConfigDir: value }, jinnHome())).toMatch(message);
  });

  it("refuses a directory inside the instance home", () => {
    expect(validateEmployeeClaudeConfigDir({ claudeConfigDir: path.join(jinnHome(), "profiles", "x") }, jinnHome()))
      .toMatch(/inside the instance home/);
  });

  it("refuses the gateway's own profile, however it is spelled", () => {
    expect(validateEmployeeClaudeConfigDir({ claudeConfigDir: `${defaultDir}/` }, jinnHome())).toMatch(/gateway's own Claude profile/);
  });

  it("refuses the field on a remote employee", () => {
    expect(validateEmployeeClaudeConfigDir({ claudeConfigDir: "/Users/operator/.claude-friend", remoteHost: "box" }, jinnHome()))
      .toMatch(/remoteClaudeConfigDir/);
  });

  it("refuses a non-string value", () => {
    expect(validateEmployeeClaudeConfigDir({ claudeConfigDir: 42 as unknown as string }, jinnHome())).toMatch(/non-empty path/);
  });
});

describe("resolveEmployeeClaudeProfile", () => {
  it("is null without the field, and for a remote employee", () => {
    expect(resolveEmployeeClaudeProfile(undefined)).toBeNull();
    expect(resolveEmployeeClaudeProfile({})).toBeNull();
    expect(resolveEmployeeClaudeProfile({ claudeConfigDir: "/p", remoteHost: "box" })).toBeNull();
  });

  it("is the canonical profile for a local employee", () => {
    expect(resolveEmployeeClaudeProfile({ claudeConfigDir: "/Users/operator/.claude-friend/" }))
      .toEqual(claudeProfileFromDir("/Users/operator/.claude-friend"));
  });
});

describe("the child environment (FR-051)", () => {
  it("sets CLAUDE_CONFIG_DIR and drops an inherited CLAUDE_SECURESTORAGE_CONFIG_DIR for a named profile", () => {
    const profile = claudeProfileFromDir("/Users/operator/.claude-friend");
    const env = buildEngineChildEnv({ PATH: "/bin", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/elsewhere" }, { claudeProfile: profile });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/operator/.claude-friend");
    expect(env).not.toHaveProperty("CLAUDE_SECURESTORAGE_CONFIG_DIR");
  });

  it("leaves the default profile's environment exactly as it was", () => {
    const base = { PATH: "/bin", CLAUDE_CONFIG_DIR: defaultDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: "/keep" };
    expect(buildEngineChildEnv(base, { claudeProfile: null })).toEqual(buildEngineChildEnv(base));
    expect(applyClaudeProfileEnv({ A: "1" }, null)).toEqual({ A: "1" });
  });
});

describe("verifyLocalClaudeProfile (FR-054)", () => {
  it("refuses a profile directory that does not exist, with the exact login command", () => {
    const profile = claudeProfileFromDir(path.join(tmp, "missing"));
    const keychain = vi.fn(() => true);
    expect(verifyLocalClaudeProfile(profile, { platform: "darwin", keychain })).toBe(
      `The Claude profile \`${profile.dir}\` does not exist. To sign it in on this machine, run \`CLAUDE_CONFIG_DIR=${profile.dir} claude\`, then \`/login\`.`,
    );
    expect(keychain).not.toHaveBeenCalled();
  });

  it("on macOS asks the Keychain for the suffixed service by name, and caches only a success", () => {
    const dir = path.join(tmp, "friend");
    fs.mkdirSync(dir);
    const profile = claudeProfileFromDir(dir);
    const keychain = vi.fn(() => false);
    expect(verifyLocalClaudeProfile(profile, { platform: "darwin", keychain })).toMatch(/is not signed in/);
    expect(keychain).toHaveBeenCalledWith(`Claude Code-credentials-${profile.key}`);
    keychain.mockReturnValue(true);
    expect(verifyLocalClaudeProfile(profile, { platform: "darwin", keychain })).toBeUndefined();
    expect(verifyLocalClaudeProfile(profile, { platform: "darwin", keychain })).toBeUndefined();
    expect(keychain).toHaveBeenCalledTimes(2);
  });

  it("elsewhere looks for a non-empty .credentials.json", () => {
    const dir = path.join(tmp, "friend");
    fs.mkdirSync(dir);
    const profile = claudeProfileFromDir(dir);
    expect(verifyLocalClaudeProfile(profile, { platform: "linux" })).toMatch(/is not signed in/);
    fs.writeFileSync(path.join(dir, ".credentials.json"), "{}");
    expect(verifyLocalClaudeProfile(profile, { platform: "linux" })).toBeUndefined();
  });

  it("passes the default profile without looking", () => {
    expect(verifyLocalClaudeProfile(null, { keychain: () => { throw new Error("must not probe"); } })).toBeUndefined();
  });
});

describe("the file-read policy protects every profile (FR-050)", () => {
  it("refuses auth files under a named profile once the roster names it", () => {
    const dir = path.join(tmp, "friend");
    fs.mkdirSync(dir);
    const file = path.join(dir, "auth-token");
    fs.writeFileSync(file, "x");
    expect(assessFileRead(file).allowed).toBe(true);
    registerClaudeProfileDirs(() => [dir]);
    expect(assessFileRead(file)).toEqual({ allowed: false, reason: "Refusing to read Claude auth files" });
  });
});
