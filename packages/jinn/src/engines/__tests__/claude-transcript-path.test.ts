import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";
import { findSessionTranscript } from "../claude-transcript-path.js";

describe("findSessionTranscript", () => {
  afterEach(() => vi.unstubAllEnvs());

  function setup() {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-profile-"));
    const ownDir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-own-profile-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", ownDir);
    return { profileDir, ownDir };
  }

  function writeTranscript(configDir: string, sessionId: string): string {
    const dir = path.join(configDir, "projects", "-some-project");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, "{}\n");
    return file;
  }

  it("finds the transcript under the given profile", () => {
    const { profileDir } = setup();
    const file = writeTranscript(profileDir, "sess-on-profile");
    expect(findSessionTranscript("sess-on-profile", claudeProfileFromDir(profileDir))).toBe(file);
  });

  it("does not look under the gateway's own profile for a session on another one", () => {
    const { profileDir, ownDir } = setup();
    writeTranscript(profileDir, "sess-only-on-profile");
    expect(findSessionTranscript("sess-only-on-profile", null)).toBeUndefined();
    expect(findSessionTranscript("sess-only-on-profile", undefined)).toBeUndefined();
    const own = writeTranscript(ownDir, "sess-on-own");
    expect(findSessionTranscript("sess-on-own", null)).toBe(own);
    expect(findSessionTranscript("sess-on-own", claudeProfileFromDir(profileDir))).toBeUndefined();
  });
});
