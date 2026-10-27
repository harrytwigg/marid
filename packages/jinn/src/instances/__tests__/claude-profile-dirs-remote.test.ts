import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeConfigDirsOf } from "../claude-profile-dirs.js";

/** The directories of a home that a rename moves or rewrites are the gateway's own: a remote account's directory is on another host. */
describe("claudeConfigDirsOf", () => {
  it("lists a local account's directory and leaves a remote account's out", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-profile-dirs-"));
    fs.writeFileSync(path.join(home, "config.yaml"), [
      "engines:",
      "  claude:",
      "    accounts:",
      "      local:",
      "        configDir: /srv/operator/.claude-local",
      "      spare:",
      "        remoteHost: build-host",
      "        remoteUser: me",
      "        configDir: /home/me/.claude-b",
      "",
    ].join("\n"));
    const dirs = claudeConfigDirsOf(home);
    expect(dirs).toContain("/srv/operator/.claude-local");
    expect(dirs).not.toContain("/home/me/.claude-b");
  });
});
