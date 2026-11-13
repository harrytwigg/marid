import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { JinnConfig } from "../types.js";
import { buildRegistry, invalidateModelRegistry, refreshOpencodeModels } from "../models.js";
import { opencodeClones } from "../opencode-catalogue.js";

/**
 * Discovery keeps the clone records of the base providers accounts name (design,
 * "Catalogue cloning") from whichever CLI generation answered, and the registry
 * lists the account's models from the same catalogue. A fake `opencode` binary
 * answers as 2.x (`api model.list`) or 1.x (`models --verbose`).
 */

const SENTINEL = "sentinel-key-value-0123456789";
const URL_A = "https://go.example.test/openai/v1";

const API_JSON = JSON.stringify({
  data: [
    { id: "alpha", providerID: "base-go", enabled: true, name: "Alpha", package: "@opencode/ai/providers/openai-compatible", settings: { apiKey: SENTINEL, baseURL: URL_A },
      cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0 } }], limit: { context: 100_000, output: 8_000 }, variants: [{ id: "high", settings: { reasoningEffort: "high" } }] },
    { id: "beta", providerID: "base-go", enabled: true, name: "Beta", package: "@opencode/ai/providers/anthropic", settings: { baseURL: "https://go.example.test/anthropic/v1" }, limit: { context: 50_000 } },
    { id: "x", providerID: "other", enabled: true, package: "@opencode/ai/providers/openai-compatible", settings: { apiKey: SENTINEL, baseURL: "https://other.example.test" } },
  ],
});

const V1_TEXT = ["alpha", "beta"].map((id) => `base-go/${id}\n${JSON.stringify({
  id, providerID: "base-go", name: id, api: { id, url: URL_A, npm: "@ai-sdk/openai-compatible" },
  cost: { input: 1, output: 2, cache: { read: 0.1, write: 0 } }, limit: { context: 100_000, output: 8_000 }, variants: { high: { reasoningEffort: "high" } },
  options: { apiKey: SENTINEL },
}, null, 2)}`).join("\n") + "\nother/x\n";

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-accounts-catalogue-")); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  // No catalogue and no clones, for the next test and the next file.
  await refreshOpencodeModels(configFor(path.join(dir, "missing")));
  invalidateModelRegistry();
});

/** An opencode that answers as `generation` says: 2.x has `api model.list` and no `--verbose`; 1.x the reverse. */
function fakeBin(name: string, generation: 1 | 2): string {
  fs.writeFileSync(path.join(dir, `${name}.json`), API_JSON);
  fs.writeFileSync(path.join(dir, `${name}.txt`), V1_TEXT);
  const bin = path.join(dir, name);
  const script = generation === 2
    ? `case "$*" in *--verbose*) echo "Unrecognized flag: --verbose" >&2; exit 1;; "api model.list"*) cat '${dir}/${name}.json';; *) printf 'base-go/alpha\\n';; esac`
    : `case "$*" in *--verbose*) cat '${dir}/${name}.txt';; "api"*) exit 1;; *) printf 'base-go/alpha\\n';; esac`;
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

function configFor(bin: string, accounts?: Record<string, unknown>): JinnConfig {
  return { gateway: {}, engines: { default: "claude", opencode: { bin, ...(accounts ? { accounts } : {}) } }, sessions: {} } as unknown as JinnConfig;
}
const ACCOUNTS = { b: { provider: "go-b", base: "base-go", keyEnv: "GO_B_KEY" } };

describe.skipIf(process.platform === "win32")("catalogue cloning through discovery", () => {
  for (const generation of [2, 1] as const) {
    it(`keeps the base's records and lists the account's models (OpenCode ${generation}.x)`, async () => {
      const config = configFor(fakeBin(`oc${generation}`, generation), ACCOUNTS);
      await refreshOpencodeModels(config);
      const records = opencodeClones().get("base-go") ?? [];
      expect(records.map((r) => r.id)).toEqual(["alpha", "beta"]);
      expect(records[0]).toMatchObject({ npm: expect.stringMatching(/openai-compatible$/), endpoint: URL_A, cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0 }, variants: { high: { reasoningEffort: "high" } } });
      expect(JSON.stringify([...opencodeClones()])).not.toContain(SENTINEL);
      // Providers no account names are not kept.
      expect(opencodeClones().has("other")).toBe(false);

      invalidateModelRegistry();
      const models = buildRegistry(config).opencode.models;
      expect(models.find((m) => m.id === "go-b/alpha")).toMatchObject({ label: "alpha", contextWindow: 100_000, effortLevels: ["high"], account: "b" });
      expect(models.find((m) => m.id === "go-b/beta")).toMatchObject({ account: "b" });
      expect(models.find((m) => m.id === "base-go/alpha")).not.toHaveProperty("account");
    });
  }

  it("keeps nothing when no account names a base, so a gateway without accounts holds no extra records", async () => {
    await refreshOpencodeModels(configFor(fakeBin("oc-none", 2)));
    expect(opencodeClones().size).toBe(0);
    invalidateModelRegistry();
    expect(buildRegistry(configFor(fakeBin("oc-none", 2))).opencode.models.some((m) => m.account !== undefined)).toBe(false);
  });

  it("lists no account model while the base is not in the catalogue", async () => {
    const config = configFor(fakeBin("oc-missing-base", 2), { b: { ...ACCOUNTS.b, base: "nowhere" } });
    await refreshOpencodeModels(config);
    invalidateModelRegistry();
    expect(opencodeClones().size).toBe(0);
    expect(buildRegistry(config).opencode.models.some((m) => m.id.startsWith("go-b/"))).toBe(false);
  });

  it("follows a changed config: an account added later is cloned at the next refresh", async () => {
    const bin = fakeBin("oc-later", 2);
    await refreshOpencodeModels(configFor(bin));
    expect(opencodeClones().size).toBe(0);
    await refreshOpencodeModels(configFor(bin, ACCOUNTS));
    expect(opencodeClones().get("base-go")).toHaveLength(2);
  });
});

describe.skipIf(process.platform === "win32")("the registry on a local 1.x binary", () => {
  const BETA_URL = "https://go.example.test/anthropic/v1";
  /** 1.x's `--verbose` list with `beta` served from another endpoint than the block's, and a `--version` that says which generation it is. */
  function versionedBin(name: string, version: string): string {
    const text = ["alpha", "beta", "gamma"].map((id) => `base-go/${id}\n${JSON.stringify({
      id, providerID: "base-go", name: id, api: { id, url: id === "beta" ? BETA_URL : URL_A, npm: "@ai-sdk/openai-compatible" },
      limit: { context: 100_000, output: 8_000 }, variants: {},
    }, null, 2)}`).join("\n") + "\n";
    fs.writeFileSync(path.join(dir, `${name}.txt`), text);
    const bin = path.join(dir, name);
    fs.writeFileSync(bin, `#!/bin/sh\ncase "$*" in --version) echo ${version};; *--verbose*) cat '${dir}/${name}.txt';; *) printf 'base-go/alpha\\n';; esac\n`, { mode: 0o755 });
    return bin;
  }

  it("leaves the model off the main endpoint out of the account's models, so a chain link to it is skipped and no picker offers it", async () => {
    const config = configFor(versionedBin("oc-v1-drop", "1.19.0"), ACCOUNTS);
    await refreshOpencodeModels(config);
    invalidateModelRegistry();
    const ids = buildRegistry(config).opencode.models.map((m) => m.id);
    expect(ids).toContain("go-b/alpha");
    expect(ids).not.toContain("go-b/beta");
    // The base provider's own models are untouched: this account is the only thing 1.x cannot serve.
    expect(ids).toContain("base-go/beta");
  });

  it("lists every model of the account on OpenCode 2", async () => {
    const config = configFor(versionedBin("oc-v2-keep", "2.0.32"), ACCOUNTS);
    await refreshOpencodeModels(config);
    invalidateModelRegistry();
    const ids = buildRegistry(config).opencode.models.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["go-b/alpha", "go-b/beta"]));
  });
});
