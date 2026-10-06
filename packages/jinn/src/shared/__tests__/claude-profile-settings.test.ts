import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeProfileFromDir } from "../claude-profile.js";
import { operatorSettingsCarry } from "../claude-profile-settings.js";
import { buildSessionSettings } from "../claude-settings.js";
import { ensureClaudeProfileTrust, resetClaudeProfileTrustForTests } from "../../engines/claude-profile-launch.js";

let tmp: string;
let defaultDir: string;

const OPERATOR_SETTINGS = {
  attribution: { commit: "", pr: "", sessionUrl: false },
  hooks: {
    PreToolUse: [{ matcher: "mcp__chat__send_message", hooks: [{ type: "command", command: "guard.sh" }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: "not-carried.sh" }] }],
  },
  skipDangerousModePermissionPrompt: true,
  theme: "dark",
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-profile-settings-")));
  defaultDir = path.join(tmp, "default-claude");
  fs.mkdirSync(defaultDir);
  fs.writeFileSync(path.join(defaultDir, "settings.json"), JSON.stringify(OPERATOR_SETTINGS));
  vi.stubEnv("CLAUDE_CONFIG_DIR", defaultDir);
  resetClaudeProfileTrustForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const named = () => claudeProfileFromDir(path.join(tmp, "friend"));
const settingsFor = (carry: ReturnType<typeof operatorSettingsCarry>) =>
  buildSessionSettings({ sessionId: "s1", relayScript: "/relay.mjs", carry });

describe("operator settings travel with a named-profile session (FR-052a)", () => {
  it("carries attribution", () => {
    expect(settingsFor(operatorSettingsCarry(named())).attribution).toEqual({ commit: "", pr: "", sessionUrl: false });
  });

  it("carries skipDangerousModePermissionPrompt", () => {
    expect(settingsFor(operatorSettingsCarry(named())).skipDangerousModePermissionPrompt).toBe(true);
  });

  it("merges the operator's PreToolUse hooks after the gateway's relay, and carries no other hook", () => {
    const settings = settingsFor(operatorSettingsCarry(named()));
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toContain("/relay.mjs");
    expect(settings.hooks.PreToolUse[1]).toEqual(OPERATOR_SETTINGS.hooks.PreToolUse[0]);
    expect(JSON.stringify(settings.hooks.PostToolUse)).not.toContain("not-carried.sh");
    expect(settings).not.toHaveProperty("theme");
  });

  it("changes nothing for the default profile", () => {
    expect(operatorSettingsCarry(null)).toBeUndefined();
    expect(settingsFor(undefined)).toEqual(buildSessionSettings({ sessionId: "s1", relayScript: "/relay.mjs" }));
  });

  it("carries nothing when the operator's file is missing or not an object", () => {
    fs.rmSync(path.join(defaultDir, "settings.json"));
    expect(operatorSettingsCarry(named())).toEqual({});
    fs.writeFileSync(path.join(defaultDir, "settings.json"), "[1]");
    expect(operatorSettingsCarry(named())).toEqual({});
  });
});

describe("per-profile folder trust (FR-052)", () => {
  it("seeds the named profile's own .claude.json before the first spawn in a cwd", () => {
    const profile = named();
    const cwd = path.join(tmp, "work");
    fs.mkdirSync(cwd);
    ensureClaudeProfileTrust(profile, cwd);
    const data = JSON.parse(fs.readFileSync(path.join(profile.dir, ".claude.json"), "utf-8"));
    expect(data.projects[cwd].hasTrustDialogAccepted).toBe(true);
    expect(data.hasCompletedOnboarding).toBe(true);
    expect(fs.existsSync(path.join(defaultDir, ".claude.json"))).toBe(false);
  });

  it("is cached per profile and cwd, so a second spawn does not rewrite the file", () => {
    const profile = named();
    const cwd = path.join(tmp, "work");
    fs.mkdirSync(cwd);
    ensureClaudeProfileTrust(profile, cwd);
    fs.rmSync(path.join(profile.dir, ".claude.json"));
    ensureClaudeProfileTrust(profile, cwd);
    expect(fs.existsSync(path.join(profile.dir, ".claude.json"))).toBe(false);
    const other = path.join(tmp, "other");
    fs.mkdirSync(other);
    ensureClaudeProfileTrust(profile, other);
    expect(fs.existsSync(path.join(profile.dir, ".claude.json"))).toBe(true);
  });

  it("does nothing for the default profile", () => {
    ensureClaudeProfileTrust(null, tmp);
    expect(fs.existsSync(path.join(defaultDir, ".claude.json"))).toBe(false);
  });
});
