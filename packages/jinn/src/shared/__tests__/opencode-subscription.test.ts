import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetOpencodeAccountKeysForTest, setOpencodeAccountKeyEnv } from "../child-env.js";
import { forgetOpencodeAccountsForTest, opencodeCredentialChanged, rememberOpencodeAccounts } from "../opencode-subscription.js";
import { validateConfigShape } from "../config.js";
import type { JinnConfig } from "../config-types.js";
import { opencodeSubscriptionProblems } from "../opencode-usage-limits-config.js";
import {
  isOpencodeSubscriptionProvider,
  opencodeCredentialFingerprint,
  opencodeModelHealthKey,
  opencodeReprobeMs,
  providerOfOpencodeHealthKey,
} from "../opencode-subscription.js";

const config = (opencode: Record<string, unknown> = {}) => ({ engines: { default: "claude", claude: {}, opencode } }) as unknown as JinnConfig;

describe("isOpencodeSubscriptionProvider", () => {
  it("defaults to opencode-go and nothing else", () => {
    expect(isOpencodeSubscriptionProvider("opencode-go", config())).toBe(true);
    expect(isOpencodeSubscriptionProvider("openrouter", config())).toBe(false);
    expect(isOpencodeSubscriptionProvider("opencode-go", undefined)).toBe(true);
  });

  it("reads the configured list instead of the default", () => {
    const configured = config({ subscriptionProviders: ["acme-plan"] });
    expect(isOpencodeSubscriptionProvider("acme-plan", configured)).toBe(true);
    expect(isOpencodeSubscriptionProvider("opencode-go", configured)).toBe(false);
    expect(isOpencodeSubscriptionProvider("opencode-go", config({ subscriptionProviders: [] }))).toBe(false);
  });

  it("is false for a missing provider", () => {
    expect(isOpencodeSubscriptionProvider(undefined, config())).toBe(false);
    expect(isOpencodeSubscriptionProvider("", config())).toBe(false);
  });
});

describe("opencodeReprobeMs", () => {
  it("is an hour unless configured, and ignores a value that is not a positive number", () => {
    expect(opencodeReprobeMs("opencode-go", config())).toBe(60 * 60_000);
    expect(opencodeReprobeMs("opencode-go", config({ reprobeMinutes: 15 }))).toBe(15 * 60_000);
    for (const bad of [0, -5, "30", Number.NaN]) expect(opencodeReprobeMs("opencode-go", config({ reprobeMinutes: bad }))).toBe(60 * 60_000);
  });
});

describe("health keys", () => {
  it("names a model's key from the model as a link spells it", () => {
    expect(opencodeModelHealthKey("opencode-go/kimi-k2")).toBe("opencode/opencode-go/kimi-k2");
    expect(opencodeModelHealthKey("openrouter/anthropic/claude-x")).toBe("opencode/openrouter/anthropic/claude-x");
    expect(opencodeModelHealthKey("no-provider")).toBeUndefined();
    expect(opencodeModelHealthKey(undefined)).toBeUndefined();
  });

  it("reads the provider out of either key", () => {
    expect(providerOfOpencodeHealthKey("opencode/opencode-go")).toBe("opencode-go");
    expect(providerOfOpencodeHealthKey("opencode/opencode-go/kimi-k2")).toBe("opencode-go");
    expect(providerOfOpencodeHealthKey("claude")).toBeUndefined();
  });
});

describe("opencodeCredentialFingerprint", () => {
  let data: string;
  const env = () => ({ XDG_DATA_HOME: data }) as NodeJS.ProcessEnv;

  function seed(rows: Array<{ id: string; integration: string; active: number | null; updated: number; value?: string }>): void {
    fs.mkdirSync(path.join(data, "opencode"), { recursive: true });
    const db = new Database(path.join(data, "opencode", "opencode.db"));
    db.exec("CREATE TABLE IF NOT EXISTS credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)");
    db.exec("DELETE FROM credential");
    const insert = db.prepare("INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, 'API key', ?, ?, 1, ?)");
    for (const row of rows) insert.run(row.id, row.integration, row.value ?? "sk-secret-value", row.active, row.updated);
    db.close();
  }

  beforeEach(() => { data = fs.mkdtempSync(path.join(os.tmpdir(), "oc-fingerprint-")); });
  afterEach(() => { fs.rmSync(data, { recursive: true, force: true }); });

  it("is an opaque hash of the stored credential's identity, never its secret", () => {
    seed([{ id: "cred_1", integration: "opencode-go", active: null, updated: 1000, value: "sk-secret-value" }]);
    const fingerprint = opencodeCredentialFingerprint("opencode-go", config(), {}, env())!;
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(fingerprint).not.toContain("secret");
  });

  it("changes when the credential is replaced or re-saved, and not when another provider's does", () => {
    seed([{ id: "cred_1", integration: "opencode-go", active: null, updated: 1000 }, { id: "cred_2", integration: "openrouter", active: null, updated: 5 }]);
    const before = opencodeCredentialFingerprint("opencode-go", config(), {}, env());
    seed([{ id: "cred_1", integration: "opencode-go", active: null, updated: 1000 }, { id: "cred_2", integration: "openrouter", active: null, updated: 6 }]);
    expect(opencodeCredentialFingerprint("opencode-go", config(), {}, env())).toBe(before);
    seed([{ id: "cred_1", integration: "opencode-go", active: null, updated: 2000, value: "sk-new" }]);
    expect(opencodeCredentialFingerprint("opencode-go", config(), {}, env())).not.toBe(before);
    seed([{ id: "cred_9", integration: "opencode-go", active: null, updated: 1000 }]);
    expect(opencodeCredentialFingerprint("opencode-go", config(), {}, env())).not.toBe(before);
  });

  it("is undefined when nothing can be read: no database, no row for the provider, a remote turn", () => {
    expect(opencodeCredentialFingerprint("opencode-go", config(), {}, env())).toBeUndefined();
    seed([{ id: "cred_1", integration: "openrouter", active: null, updated: 1 }]);
    expect(opencodeCredentialFingerprint("opencode-go", config(), {}, env())).toBeUndefined();
    seed([{ id: "cred_1", integration: "opencode-go", active: null, updated: 1 }]);
    expect(opencodeCredentialFingerprint("opencode-go", config(), { remote: true }, env())).toBeUndefined();
  });

  it("ignores a stale auth.json beside the database", () => {
    fs.mkdirSync(path.join(data, "opencode"), { recursive: true });
    fs.writeFileSync(path.join(data, "opencode", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "sk-old" } }));
    expect(opencodeCredentialFingerprint("opencode-go", config(), {}, env())).toBeUndefined();
  });
});

describe("opencodeSubscriptionProblems", () => {
  const check = (opencode: unknown) => opencodeSubscriptionProblems({ opencode });

  it("accepts the defaults, a list of names and a positive number of minutes", () => {
    expect(opencodeSubscriptionProblems({ claude: {} })).toEqual([]);
    expect(check({})).toEqual([]);
    expect(check({ subscriptionProviders: ["opencode-go", "acme-plan"], reprobeMinutes: 30 })).toEqual([]);
    expect(check({ subscriptionProviders: [] })).toEqual([]);
  });

  it("names a list that is not a list of names, and an interval that is not a positive number", () => {
    expect(check({ subscriptionProviders: "opencode-go" })).toEqual(["engines.opencode.subscriptionProviders must be a list of provider names"]);
    expect(check({ subscriptionProviders: ["ok", 3] })).toHaveLength(1);
    expect(check({ subscriptionProviders: [""] })).toHaveLength(1);
    for (const bad of ["60", 0, -1, Number.NaN]) expect(check({ reprobeMinutes: bad })).toHaveLength(1);
  });

  it("is checked with the rest of the config", () => {
    const problems = validateConfigShape({ gateway: {}, engines: { default: "claude", claude: {}, opencode: { reprobeMinutes: "soon" } } });
    expect(problems.some((problem) => problem.includes("engines.opencode.reprobeMinutes"))).toBe(true);
  });
});


describe("declared accounts", () => {
  const accounts = {
    "go-b": { provider: "go-b", base: "opencode-go", keyEnv: "SUB_TEST_KEY_B" },
    "router-b": { provider: "router-b", base: "openrouter", keyEnv: "SUB_TEST_KEY_R" },
    builtin: { provider: "opencode-go" },
  };
  const withAccounts = (opencode: Record<string, unknown> = {}) => config({ accounts, ...opencode });

  afterEach(() => { resetOpencodeAccountKeysForTest(); forgetOpencodeAccountsForTest(); });

  it("counts an account whose base is a subscription provider, and not one whose base is not", () => {
    expect(isOpencodeSubscriptionProvider("go-b", withAccounts())).toBe(true);
    expect(isOpencodeSubscriptionProvider("router-b", withAccounts())).toBe(false);
  });

  it("counts a built-in account whose provider is a subscription, and follows a configured list", () => {
    expect(isOpencodeSubscriptionProvider("opencode-go", withAccounts())).toBe(true);
    const listed = withAccounts({ subscriptionProviders: ["openrouter"] });
    expect(isOpencodeSubscriptionProvider("router-b", listed)).toBe(true);
    expect(isOpencodeSubscriptionProvider("go-b", listed)).toBe(false);
    expect(isOpencodeSubscriptionProvider("opencode-go", listed)).toBe(false);
  });

  it("finds an alias account from the last loaded config when none is passed", () => {
    expect(isOpencodeSubscriptionProvider("go-b", undefined)).toBe(false);
    rememberOpencodeAccounts(withAccounts());
    expect(isOpencodeSubscriptionProvider("go-b", undefined)).toBe(true);
  });

  describe("fingerprint of an alias account", () => {
    const sha = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);

    it("is a short sha256 of the resolved key, never the key", () => {
      setOpencodeAccountKeyEnv(["SUB_TEST_KEY_B"], { SUB_TEST_KEY_B: "sk-alias-secret" });
      const fingerprint = opencodeCredentialFingerprint("go-b", withAccounts())!;
      expect(fingerprint).toBe(sha("sk-alias-secret"));
      expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);
      expect(fingerprint).not.toContain("secret");
    });

    it("reads the key the gateway took, not process.env, and changes when the key is rotated", () => {
      process.env.SUB_TEST_KEY_B = "sk-from-process-env";
      try {
        setOpencodeAccountKeyEnv(["SUB_TEST_KEY_B"], { SUB_TEST_KEY_B: "sk-one" });
        const first = opencodeCredentialFingerprint("go-b", withAccounts());
        setOpencodeAccountKeyEnv(["SUB_TEST_KEY_B"], { SUB_TEST_KEY_B: "sk-two" });
        expect(opencodeCredentialFingerprint("go-b", withAccounts())).not.toBe(first);
        expect(first).toBe(sha("sk-one"));
      } finally {
        delete process.env.SUB_TEST_KEY_B;
      }
    });

    it("is undefined with no key set, on a remote host, and finds the account from the last loaded config", () => {
      expect(opencodeCredentialFingerprint("go-b", withAccounts())).toBeUndefined();
      setOpencodeAccountKeyEnv(["SUB_TEST_KEY_B"], { SUB_TEST_KEY_B: "sk-one" });
      expect(opencodeCredentialFingerprint("go-b", withAccounts(), { remote: true })).toBeUndefined();
      expect(opencodeCredentialFingerprint("go-b", undefined)).toBeUndefined();
      rememberOpencodeAccounts(withAccounts());
      expect(opencodeCredentialFingerprint("go-b", undefined)).toBe(sha("sk-one"));
    });

    it("leaves a built-in account to the stored credential: its fingerprint is the database's, whatever key variables are held", () => {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), "oc-builtin-fingerprint-"));
      try {
        fs.mkdirSync(path.join(data, "opencode"), { recursive: true });
        const db = new Database(path.join(data, "opencode", "opencode.db"));
        db.exec("CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)");
        db.prepare("INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES ('cred_1', 'opencode-go', 'API key', 'sk-db-secret', NULL, 1, 1000)").run();
        db.close();
        const env = { XDG_DATA_HOME: data } as NodeJS.ProcessEnv;
        const withoutAccounts = opencodeCredentialFingerprint("opencode-go", config(), {}, env);
        expect(withoutAccounts).toMatch(/^[0-9a-f]{32}$/);
        setOpencodeAccountKeyEnv(["SUB_TEST_KEY_B"], { SUB_TEST_KEY_B: "sk-one" });
        expect(opencodeCredentialFingerprint("opencode-go", withAccounts(), {}, env)).toBe(withoutAccounts);
        expect(withoutAccounts).not.toBe(sha("sk-one"));
      } finally {
        fs.rmSync(data, { recursive: true, force: true });
      }
    });

    it("finds an alias account in the remembered config when the config passed does not declare it", () => {
      setOpencodeAccountKeyEnv(["SUB_TEST_KEY_B"], { SUB_TEST_KEY_B: "sk-one" });
      rememberOpencodeAccounts(withAccounts());
      expect(isOpencodeSubscriptionProvider("go-b", config())).toBe(true);
      expect(opencodeCredentialFingerprint("go-b", config())).toBe(sha("sk-one"));
    });
  });

  describe("opencodeCredentialChanged", () => {
    const sha = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);

    it("is false while the key is the one the record was written against, true once it changed", () => {
      rememberOpencodeAccounts(withAccounts());
      setOpencodeAccountKeyEnv(["SUB_TEST_KEY_B"], { SUB_TEST_KEY_B: "sk-one" });
      expect(opencodeCredentialChanged("go-b", sha("sk-one"))).toBe(false);
      setOpencodeAccountKeyEnv(["SUB_TEST_KEY_B"], { SUB_TEST_KEY_B: "sk-two" });
      expect(opencodeCredentialChanged("go-b", sha("sk-one"))).toBe(true);
    });

    it("is false in a process that does not hold the key: an operator's shell cannot say the key changed", () => {
      rememberOpencodeAccounts(withAccounts());
      expect(opencodeCredentialChanged("go-b", sha("sk-one"))).toBe(false);
    });

    it("keeps reading an unreadable credential of any other provider as changed", () => {
      rememberOpencodeAccounts(withAccounts());
      const previous = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = path.join(os.tmpdir(), "no-such-opencode-data");
      try {
        expect(opencodeCredentialChanged("opencode-go", "0123456789abcdef0123456789abcdef")).toBe(true);
        expect(opencodeCredentialChanged("openrouter", "0123456789abcdef0123456789abcdef")).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous;
      }
    });
  });
});
