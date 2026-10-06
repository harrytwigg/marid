import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";
import { loadRawTranscript, loadTranscriptMessages } from "../claude-transcript-loaders.js";

describe("Claude transcript loaders", () => {
  let profileDir: string;
  let ownDir: string;

  beforeEach(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-profile-"));
    ownDir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-own-profile-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", ownDir);
    const dir = path.join(profileDir, "projects", "-some-project");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "sess-on-profile.jsonl"),
      [
        { type: "user", message: { role: "user", content: "a question" } },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "an answer" }] } },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  it("loadRawTranscript reads the transcript from the given profile", () => {
    expect(loadRawTranscript("sess-on-profile", claudeProfileFromDir(profileDir))).toEqual([
      { role: "user", content: [{ type: "text", text: "a question" }] },
      { role: "assistant", content: [{ type: "text", text: "an answer" }] },
    ]);
    expect(loadRawTranscript("sess-on-profile", null)).toEqual([]);
  });

  it("loadTranscriptMessages reads the transcript from the given profile", () => {
    expect(loadTranscriptMessages("sess-on-profile", claudeProfileFromDir(profileDir)).map((m) => m.content)).toEqual([
      "a question",
      "an answer",
    ]);
    expect(loadTranscriptMessages("sess-on-profile", null)).toEqual([]);
  });
});
