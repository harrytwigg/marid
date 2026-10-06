import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * FR-054 in preflight: a Claude turn on a named profile that does not exist,
 * or is not signed in, is refused with the command that signs it in. That
 * holds on every path, the web chat and terminal view included: those pass an
 * engine override, which exempts them from the default login's own check, but
 * a signed-out profile would otherwise put Claude Code's login screen in front
 * of an unattended turn.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
const keychain = vi.hoisted(() => ({ present: false, asked: [] as string[] }));
vi.mock("../../shared/claude-profile-signin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/claude-profile-signin.js")>();
  return {
    ...actual,
    verifyLocalClaudeProfile: (profile: Parameters<typeof actual.verifyLocalClaudeProfile>[0]) =>
      actual.verifyLocalClaudeProfile(profile, {
        platform: "darwin",
        keychain: (service) => { keychain.asked.push(service); return keychain.present; },
      }),
  };
});

import { preflightTurn } from "../turn/preflight.js";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";
import { resetLocalProfileCheckForTests } from "../../shared/claude-profile-signin.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Employee } from "../../shared/types.js";

const profileDir = path.join(JINN_HOME, "..", `preflight-claude-friend-${process.pid}`);

function preflight(employee: Partial<Employee>, engineOverride: boolean) {
  const engine = { run: vi.fn() };
  return preflightTurn({
    session: { id: "s1", engine: "claude", source: "web", employee: employee.name ?? null } as any,
    attemptToken: "t1",
    prompt: "hi",
    attachments: [],
    employee: { name: "side-dev", engine: "claude", ...employee } as Employee,
    config: { engines: { default: "claude", claude: {} } } as any,
    engines: new Map([["claude", engine as any]]),
    ...(engineOverride ? { engineOverride: engine as any } : {}),
    gatewayBootId: "b",
    connectorNames: [],
    channel: "web",
    user: "web-user",
  } as any);
}

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
  resetLocalProfileCheckForTests();
  keychain.present = false;
  keychain.asked.length = 0;
});

describe("preflight refuses a turn on a profile that cannot sign in (FR-054)", () => {
  it.each([false, true])("a profile directory that does not exist (engine override: %s)", (override) => {
    const result = preflight({ claudeConfigDir: profileDir }, override);
    expect(result).toEqual({
      ok: false,
      error: `The Claude profile ${profileDir} does not exist. To sign it in on this machine, run \`CLAUDE_CONFIG_DIR=${profileDir} claude\`, then \`/login\`.`,
    });
  });

  it.each([false, true])("a profile with no login in the Keychain (engine override: %s)", (override) => {
    fs.mkdirSync(profileDir, { recursive: true });
    const result = preflight({ claudeConfigDir: profileDir }, override);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`The Claude profile ${profileDir} is not signed in.`) });
    expect(keychain.asked).toEqual([`Claude Code-credentials-${claudeProfileFromDir(profileDir).key}`]);
  });

  it("lets a signed-in profile through", () => {
    fs.mkdirSync(profileDir, { recursive: true });
    keychain.present = true;
    expect(preflight({ claudeConfigDir: profileDir }, true).ok).toBe(true);
  });

  it("never asks the Keychain for an employee on the default profile", () => {
    expect(preflight({}, true).ok).toBe(true);
    expect(keychain.asked).toEqual([]);
  });
});
