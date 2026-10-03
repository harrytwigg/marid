import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REMOTE_STAGE_MARKER } from "../../shared/remote-farm.js";
import { assertCommandAllowedInHome, COMMANDS_REFUSED_IN_REMOTE_STAGE } from "../remote-stage-guard.js";

describe("assertCommandAllowedInHome", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "stage-guard-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it("allows every command in an ordinary home", () => {
    for (const command of [...COMMANDS_REFUSED_IN_REMOTE_STAGE, "limits"]) {
      expect(() => assertCommandAllowedInHome([command], home)).not.toThrow();
    }
  });

  it("refuses start, stop, restart, status, pair, unpair, setup, migrate, nuke and backup in a remote session's staged home", () => {
    fs.writeFileSync(path.join(home, REMOTE_STAGE_MARKER), "stage\n");
    for (const command of ["start", "stop", "restart", "status", "pair", "unpair", "setup", "migrate", "nuke"]) {
      expect(() => assertCommandAllowedInHome([command], home)).toThrow(new RegExp(`jinn ${command}.*staged home`));
    }
    expect(() => assertCommandAllowedInHome(["backup", "run"], home)).toThrow(/jinn backup run/);
  });

  it("leaves commands that touch neither the gateway process nor the registry available", () => {
    fs.writeFileSync(path.join(home, REMOTE_STAGE_MARKER), "stage\n");
    for (const command of [["limits"], ["remote", "status"], ["skills", "list"], []]) {
      expect(() => assertCommandAllowedInHome(command, home)).not.toThrow();
    }
  });
});
