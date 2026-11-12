import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  buildEngineChildEnv,
  opencodeAccountKeyEnvironment,
  resetOpencodeAccountKeysForTest,
  setOpencodeAccountKeyEnv,
  withOpencodeAccountKeys,
} from "../child-env.js";

/** The gateway takes each account key out of its own environment at config load, so no spawn site can pass one on by accident. */
const KEY = "ACME_VAULT_KEY_A";
const LATE = "ACME_VAULT_KEY_LATE";

afterEach(() => {
  resetOpencodeAccountKeysForTest();
  delete process.env[KEY];
  delete process.env[LATE];
});

describe("account key vault", () => {
  it("moves a declared key out of the process environment and still reads it for opencode", () => {
    process.env[KEY] = "sk-vault-a";
    setOpencodeAccountKeyEnv([KEY]);
    expect(process.env[KEY]).toBeUndefined();
    expect(opencodeAccountKeyEnvironment()[KEY]).toBe("sk-vault-a");
  });

  it("leaves no key in a child that is handed the whole process environment, scrubbed or not", () => {
    process.env[KEY] = "sk-vault-a";
    setOpencodeAccountKeyEnv([KEY]);
    const probe = `process.stdout.write(process.env.${KEY} ?? "<unset>")`;
    const bare = spawnSync(process.execPath, ["-e", probe], { env: process.env, encoding: "utf8" });
    expect(bare.stdout).toBe("<unset>");
    const inherited = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
    expect(inherited.stdout).toBe("<unset>");
    expect(buildEngineChildEnv(process.env)[KEY]).toBeUndefined();
  });

  it("puts the keys back for the gateway's own successor only", () => {
    process.env[KEY] = "sk-vault-a";
    setOpencodeAccountKeyEnv([KEY]);
    const successor = withOpencodeAccountKeys({ PATH: "/bin" });
    expect(successor[KEY]).toBe("sk-vault-a");
    expect(successor.PATH).toBe("/bin");
  });

  it("keeps a key across a reload, and takes one a new account names later", () => {
    process.env[KEY] = "sk-vault-a";
    setOpencodeAccountKeyEnv([KEY]);
    process.env[LATE] = "sk-vault-late";
    setOpencodeAccountKeyEnv([KEY, LATE]);
    expect(process.env[LATE]).toBeUndefined();
    expect(opencodeAccountKeyEnvironment()).toEqual({ [KEY]: "sk-vault-a", [LATE]: "sk-vault-late" });
  });

  it("drops a blank value without keeping it, and reads an untaken variable from the base", () => {
    process.env[KEY] = "   ";
    setOpencodeAccountKeyEnv([KEY, LATE]);
    expect(process.env[KEY]).toBeUndefined();
    expect(opencodeAccountKeyEnvironment({ [LATE]: "from-base" })).toEqual({ [KEY]: undefined, [LATE]: "from-base" });
  });
});
