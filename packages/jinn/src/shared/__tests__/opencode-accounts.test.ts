import { describe, expect, it } from "vitest";
import { parseOpencodeApiModels } from "../opencode-model-records.js";
import { parseOpencodeModels } from "../opencode-models.js";
import { newCloneSink, type OpencodeCloneModel } from "../opencode-clone.js";
import { declaredOpencodeAccounts } from "../opencode-accounts-config.js";
import {
  accountCloneModels, accountModelInfos, accountRegistryModels, configNpmName, mainEndpoint, opencodeAccountProblems,
  opencodeChainContext, opencodeChainProblems, planAccountProvider,
} from "../opencode-accounts.js";
import { fallbackChainProblems } from "../fallback-chain-wire.js";
import type { ModelInfo } from "../types.js";

/** A value standing in for a key that a catalogue record carries. It must never be kept. */
const SENTINEL = "sentinel-key-value-0123456789";

const OPENAI_URL = "https://go.example.test/openai/v1";
const ANTHROPIC_URL = "https://go.example.test/anthropic/v1";
const GOOGLE_URL = "https://go.example.test/google/v1beta";

function apiRecord(over: Record<string, unknown>): Record<string, unknown> {
  return {
    providerID: "base-go",
    enabled: true,
    package: "@opencode/ai/providers/openai-compatible",
    settings: { apiKey: SENTINEL, baseURL: OPENAI_URL, provider: "base-go", headers: { "x-extra": SENTINEL } },
    cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }, { input: 5, output: 6, cache: { read: 0.5, write: 0.6 } }],
    limit: { context: 200_000, input: 150_000, output: 32_000 },
    variants: [{ id: "low", settings: { reasoningEffort: "low" } }, { id: "high", settings: { reasoningEffort: "high" } }],
    ...over,
  };
}

/** 2.x `api model.list` output: three Go-like models on two SDKs and three endpoints, and one model of another provider. */
const API_OUTPUT = JSON.stringify({
  data: [
    apiRecord({ id: "alpha", name: "Alpha" }),
    apiRecord({ id: "beta", name: "Beta", package: "@opencode/ai/providers/anthropic", settings: { apiKey: SENTINEL, baseURL: ANTHROPIC_URL } }),
    apiRecord({ id: "gamma", name: "Gamma", package: "@opencode/ai/providers/openai", variants: [], cost: [] }),
    apiRecord({ id: "delta", name: "Delta", package: "@opencode/ai/providers/google", settings: { baseURL: GOOGLE_URL }, limit: { context: 1_000_000 } }),
    apiRecord({ id: "off", providerID: "base-go", enabled: false }),
    apiRecord({ id: "other", providerID: "elsewhere" }),
  ],
});

/** The same provider as 1.x's `models --verbose` prints it (every model on one URL, one SDK each). */
function v1Block(id: string, npm: string, url: string): string {
  return [
    `base-go/${id}`,
    JSON.stringify({
      id, providerID: "base-go", name: id.toUpperCase(),
      api: { id, url, npm },
      cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 }, tiers: [{ input: 9, output: 9, cache: { read: 9, write: 9 }, tier: { type: "context", size: 100000 } }] },
      limit: { context: 128_000, output: 8_000 },
      variants: { high: { reasoningEffort: "high" } },
      headers: { authorization: SENTINEL },
      options: { apiKey: SENTINEL },
    }, null, 2),
  ].join("\n");
}
const V1_OUTPUT = [
  v1Block("alpha", "@ai-sdk/openai-compatible", OPENAI_URL),
  v1Block("beta", "@ai-sdk/anthropic", OPENAI_URL),
  v1Block("gamma", "@ai-sdk/openai", OPENAI_URL),
].join("\n");

const account = (over: Record<string, unknown> = {}) => declaredOpencodeAccounts({
  engines: { opencode: { accounts: { b: { provider: "go-b", base: "base-go", keyEnv: "GO_B_KEY", label: "Go B", ...over } } } },
} as never)[0]!;

function clonesFor(output: string, parse: typeof parseOpencodeApiModels): { clones: ReadonlyMap<string, readonly OpencodeCloneModel[]>; models: ModelInfo[] } {
  const sink = newCloneSink(["base-go"]);
  const models = parse(output, sink);
  return { clones: sink.models, models };
}

describe("catalogue cloning: OpenCode 2.x records", () => {
  const { clones } = clonesFor(API_OUTPUT, parseOpencodeApiModels);
  const go = clones.get("base-go") ?? [];

  it("keeps the base provider's enabled models only, and no other provider's", () => {
    expect(go.map((m) => m.id)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(clones.has("elsewhere")).toBe(false);
  });

  it("keeps package, settings.baseURL, limit, the first cost tier and the variants", () => {
    expect(go[0]).toEqual({
      id: "alpha",
      name: "Alpha",
      npm: "@opencode/ai/providers/openai-compatible",
      endpoint: OPENAI_URL,
      limit: { context: 200_000, input: 150_000, output: 32_000 },
      cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
      variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
    });
  });

  it("drops the rest of settings, apiKey above all, however deep it sits", () => {
    expect(JSON.stringify([...clones])).not.toContain(SENTINEL);
    expect(Object.keys(go[0]!)).not.toContain("settings");
  });

  it("leaves out a cost, variants or endpoint a record does not state", () => {
    expect(go[2]).toEqual({ id: "gamma", name: "Gamma", npm: "@opencode/ai/providers/openai", endpoint: OPENAI_URL, limit: { context: 200_000, input: 150_000, output: 32_000 } });
  });

  it("collects nothing for providers nobody asked about", () => {
    expect(clonesFor(API_OUTPUT, parseOpencodeApiModels).clones.size).toBe(1);
    const none = newCloneSink([]);
    parseOpencodeApiModels(API_OUTPUT, none);
    expect(none.models.size).toBe(0);
  });
});

describe("catalogue cloning: OpenCode 1.x records", () => {
  const { clones, models } = clonesFor(V1_OUTPUT, parseOpencodeModels);
  const go = clones.get("base-go") ?? [];

  it("keeps api.npm, api.url, limit, cost (without its tiers) and variants", () => {
    expect(go[1]).toEqual({
      id: "beta",
      name: "BETA",
      npm: "@ai-sdk/anthropic",
      endpoint: OPENAI_URL,
      limit: { context: 128_000, output: 8_000 },
      cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
      variants: { high: { reasoningEffort: "high" } },
    });
  });

  it("never keeps headers or options, so no key", () => {
    expect(JSON.stringify([...clones])).not.toContain(SENTINEL);
  });

  it("still lists the models as before", () => {
    expect(models.map((m) => m.id)).toEqual(["base-go/alpha", "base-go/beta", "base-go/gamma"]);
  });
});

describe("planAccountProvider", () => {
  const go = clonesFor(API_OUTPUT, parseOpencodeApiModels).clones.get("base-go") ?? [];

  it("takes the endpoint most models use for the block, and carries the others per model (OpenCode 2.x)", () => {
    const { block, dropped } = planAccountProvider(account(), go, 2);
    expect(dropped).toEqual([]);
    expect(block.name).toBe("Go B");
    expect(block.npm).toBe("@ai-sdk/openai-compatible");
    expect(block.options.baseURL).toBe(OPENAI_URL);
    expect(block.models.alpha).not.toHaveProperty("provider");
    // Same endpoint, another SDK: the SDK alone is per model, and its api names the endpoint it is served from.
    expect(block.models.gamma?.provider).toEqual({ npm: "@ai-sdk/openai", api: OPENAI_URL });
    expect(block.models.beta?.provider).toEqual({ npm: "@ai-sdk/anthropic", api: ANTHROPIC_URL });
    expect(block.models.delta?.provider).toEqual({ npm: "@ai-sdk/google", api: GOOGLE_URL });
  });

  it("converts @opencode/ai/providers/<sdk> to @ai-sdk/<sdk>", () => {
    expect(configNpmName("@opencode/ai/providers/openai-compatible")).toBe("@ai-sdk/openai-compatible");
    expect(configNpmName("@ai-sdk/anthropic")).toBe("@ai-sdk/anthropic");
    expect(configNpmName("some-other-provider-package")).toBe("some-other-provider-package");
  });

  it("writes cost as {input, output, cache_read, cache_write}, with limit, variants and name", () => {
    const { block } = planAccountProvider(account(), go, 2);
    expect(block.models.alpha).toEqual({
      name: "Alpha",
      limit: { context: 200_000, input: 150_000, output: 32_000 },
      cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
      variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
    });
  });

  it("carries the key only as an environment reference", () => {
    const { block } = planAccountProvider(account(), go, 2);
    expect(block.options.apiKey).toBe("{env:GO_B_KEY}");
    expect(JSON.stringify(block)).not.toContain(SENTINEL);
  });

  it("leaves out models off the block's endpoint on OpenCode 1.x, which sends every model to one", () => {
    const { block, dropped } = planAccountProvider(account(), go, 1);
    expect(dropped.sort()).toEqual(["beta", "delta"]);
    expect(Object.keys(block.models).sort()).toEqual(["alpha", "gamma"]);
    expect(block.options.baseURL).toBe(OPENAI_URL);
    // 1.x honours a per-model SDK, so the one on the same endpoint keeps its own.
    expect(block.models.gamma?.provider?.npm).toBe("@ai-sdk/openai");
  });

  it("drops nothing on 1.x when every model is on one endpoint", () => {
    const one = clonesFor(V1_OUTPUT, parseOpencodeModels).clones.get("base-go") ?? [];
    const { block, dropped } = planAccountProvider(account(), one, 1);
    expect(dropped).toEqual([]);
    expect(Object.keys(block.models)).toEqual(["alpha", "beta", "gamma"]);
    expect(block.models.beta?.provider?.npm).toBe("@ai-sdk/anthropic");
  });

  it("breaks an endpoint tie toward the one serving an openai-compatible model", () => {
    const models: OpencodeCloneModel[] = [
      { id: "a", npm: "@ai-sdk/anthropic", endpoint: "https://z.example.test/a" },
      { id: "b", npm: "@ai-sdk/openai-compatible", endpoint: "https://z.example.test/b" },
    ];
    expect(mainEndpoint(models)).toBe("https://z.example.test/b");
    expect(mainEndpoint([])).toBeUndefined();
  });

  it("cuts a subset to the models named, in the base's order", () => {
    const clones = new Map([["base-go", go]]);
    expect(accountCloneModels(account({ models: ["delta", "alpha"] }), clones).map((m) => m.id)).toEqual(["alpha", "delta"]);
    expect(accountCloneModels(account(), clones)).toHaveLength(4);
    expect(accountCloneModels(account(), new Map())).toEqual([]);
  });
});

describe("the registry's account models", () => {
  const catalogue: ModelInfo[] = [
    { id: "base-go/alpha", label: "alpha", supportsEffort: true, effortLevels: ["low", "high"], contextWindow: 200_000 },
    { id: "base-go/beta", label: "beta", supportsEffort: false, effortLevels: [] },
    { id: "elsewhere/x", label: "x", supportsEffort: false, effortLevels: [] },
  ];

  it("lists the base's models as <provider>/<model>, with its label, window and effort levels and the account name", () => {
    expect(accountModelInfos(account(), catalogue)).toEqual([
      { id: "go-b/alpha", label: "alpha", supportsEffort: true, effortLevels: ["low", "high"], contextWindow: 200_000, account: "b" },
      { id: "go-b/beta", label: "beta", supportsEffort: false, effortLevels: [], account: "b" },
    ]);
  });

  it("restricts to the subset and gives a built-in provider's declaration no models of its own", () => {
    expect(accountModelInfos(account({ models: ["beta"] }), catalogue).map((m) => m.id)).toEqual(["go-b/beta"]);
    const builtIn = { engines: { opencode: { accounts: { a: { provider: "base-go" } } } } } as never;
    expect(accountRegistryModels(builtIn, catalogue)).toEqual([]);
  });

  it("lists none when the base is not in the catalogue", () => {
    expect(accountModelInfos(account({ base: "nowhere" }), catalogue)).toEqual([]);
  });

  it("does not share effort-level arrays with the base's entry", () => {
    const [first] = accountModelInfos(account(), catalogue);
    first!.effortLevels.push("max");
    expect(catalogue[0]!.effortLevels).toEqual(["low", "high"]);
  });
});

describe("opencodeAccountProblems", () => {
  const catalogue: ModelInfo[] = [
    { id: "base-go/alpha", label: "alpha", supportsEffort: false, effortLevels: [] },
    { id: "base-go/beta", label: "beta", supportsEffort: false, effortLevels: [] },
  ];
  const config = (over: Record<string, unknown> = {}) => ({ engines: { opencode: { accounts: { b: { provider: "go-b", base: "base-go", keyEnv: "GO_B_KEY", ...over } } } } }) as never;
  const loaded = new Map<string, readonly OpencodeCloneModel[]>([["base-go", clonesFor(API_OUTPUT, parseOpencodeApiModels).clones.get("base-go") ?? []]]);
  const inputs = { catalogue, clones: loaded, env: { GO_B_KEY: "k" } };

  it("is clean for a base in the catalogue, a known subset and a set key", () => {
    expect(opencodeAccountProblems(config({ models: ["alpha"] }), inputs)).toEqual([]);
  });

  it("names a base missing from the catalogue", () => {
    expect(opencodeAccountProblems(config({ base: "nowhere" }), inputs)).toEqual([`account "b": base "nowhere" is not in opencode's catalogue on this host`]);
  });

  it("names a provider id that collides with a catalogue provider", () => {
    const problems = opencodeAccountProblems(config(), { ...inputs, catalogue: [...catalogue, { id: "go-b/zzz", label: "zzz", supportsEffort: false, effortLevels: [] }] });
    expect(problems).toEqual([expect.stringContaining(`provider "go-b" is already a provider in opencode's catalogue`)]);
  });

  it("names a subset model that is not the base's", () => {
    expect(opencodeAccountProblems(config({ models: ["alpha", "ghost"] }), inputs)).toEqual([`account "b": model "ghost" is not one of base "base-go"'s models`]);
  });

  it("names an unset key variable, never its value", () => {
    expect(opencodeAccountProblems(config(), { ...inputs, env: {} })).toEqual([`account "b" has no key: GO_B_KEY is not set`]);
    expect(opencodeAccountProblems(config(), { ...inputs, env: { GO_B_KEY: "  " } })).toEqual([`account "b" has no key: GO_B_KEY is not set`]);
  });

  it("names the models a 1.x local binary cannot reach", () => {
    const clones = new Map([["base-go", clonesFor(API_OUTPUT, parseOpencodeApiModels).clones.get("base-go") ?? []]]);
    const problems = opencodeAccountProblems(config(), { catalogue, clones, env: { GO_B_KEY: "k" }, localApi: 1 });
    expect(problems).toEqual([expect.stringContaining("left out on this host: beta, delta")]);
    expect(opencodeAccountProblems(config(), { catalogue, clones, env: { GO_B_KEY: "k" }, localApi: 2 })).toEqual([]);
  });

  it("names an account whose base has models but no endpoint records yet, since its block would be empty", () => {
    const unstaged = `account "b": the base's endpoints are not known yet (model details have not loaded), so its models cannot be served`;
    expect(opencodeAccountProblems(config(), { ...inputs, clones: new Map() })).toEqual([unstaged]);
    expect(opencodeAccountProblems(config(), inputs)).toEqual([]);
    // Nothing to say while the catalogue itself is not known.
    expect(opencodeAccountProblems(config(), { ...inputs, catalogue: null })).toEqual([]);
  });

  it("does not blame accounts for a catalogue that is not known yet, but still reports the key", () => {
    expect(opencodeAccountProblems(config({ base: "nowhere" }), { ...inputs, catalogue: null, env: {} })).toEqual([`account "b" has no key: GO_B_KEY is not set`]);
  });
});

describe("chain problems for opencode links", () => {
  const catalogue: ModelInfo[] = [
    { id: "base-go/alpha", label: "alpha", supportsEffort: false, effortLevels: [] },
    { id: "base-go/beta", label: "beta", supportsEffort: false, effortLevels: [] },
    { id: "elsewhere/x", label: "x", supportsEffort: false, effortLevels: [] },
  ];
  const config = { engines: { opencode: { accounts: { b: { provider: "go-b", base: "base-go", keyEnv: "GO_B_KEY", models: ["alpha"] } } } } } as never;
  const link = (model: string) => [{ engine: "opencode", model }];
  const problems = (model: string, ctx = opencodeChainContext(config, catalogue, { GO_B_KEY: "k" })) =>
    fallbackChainProblems("fallback", link(model), { engines: ["claude", "opencode"], profiles: new Set(), opencode: ctx });

  it("accepts an account's model, a catalogue model and a built-in provider", () => {
    expect(problems("go-b/alpha")).toEqual([]);
    expect(problems("base-go/beta")).toEqual([]);
    expect(problems("elsewhere/x")).toEqual([]);
  });

  it("refuses a model its account does not serve", () => {
    expect(problems("go-b/beta")).toEqual([`fallback[0]: model "go-b/beta" is not served by account "b"`]);
    expect(problems("go-b/nope")).toEqual([`fallback[0]: model "go-b/nope" is not served by account "b"`]);
  });

  it("refuses a provider that is neither an account's nor in the catalogue", () => {
    expect(problems("mystery/x")).toEqual([`fallback[0]: provider "mystery" is not in opencode's catalogue or engines.opencode.accounts`]);
  });

  it("reports a missing key only where an environment is given", () => {
    expect(problems("go-b/alpha", opencodeChainContext(config, catalogue, {}))).toEqual([`fallback[0]: account "b" has no key: GO_B_KEY is not set`]);
    expect(problems("go-b/alpha", opencodeChainContext(config, catalogue))).toEqual([]);
  });

  it("calls no provider unknown, and no account model unserved, while the catalogue is not known", () => {
    for (const unknown of [null, []] as const) {
      const ctx = opencodeChainContext(config, unknown);
      expect(problems("mystery/x", ctx)).toEqual([]);
      expect(problems("go-b/anything", ctx)).toEqual([]);
    }
  });

  it("checks nothing without a context, as at config load, and ignores other engines and model-less links", () => {
    expect(fallbackChainProblems("fallback", link("mystery/x"), { engines: ["claude", "opencode"], profiles: new Set() })).toEqual([]);
    const ctx = opencodeChainContext(config, catalogue);
    expect(opencodeChainProblems("fallback", [{ engine: "claude", model: "mystery/x" }, { engine: "opencode" }, "opencode"], ctx)).toEqual([]);
  });

  it("refuses a link to an account whose endpoint records have not loaded, only when clones are given", () => {
    const none = new Map<string, readonly OpencodeCloneModel[]>();
    const sentence = `fallback[0]: account "b": the base's endpoints are not known yet (model details have not loaded)`;
    expect(problems("go-b/alpha", opencodeChainContext(config, catalogue, { GO_B_KEY: "k" }, none))).toEqual([sentence]);
    expect(problems("go-b/alpha", opencodeChainContext(config, catalogue, { GO_B_KEY: "k" }))).toEqual([]);
    const loaded = new Map([["base-go", clonesFor(API_OUTPUT, parseOpencodeApiModels).clones.get("base-go") ?? []]]);
    expect(problems("go-b/alpha", opencodeChainContext(config, catalogue, { GO_B_KEY: "k" }, loaded))).toEqual([]);
  });

  it("gives opencodeChainProblems the same sentences, indexed", () => {
    const ctx = opencodeChainContext(config, catalogue);
    expect(opencodeChainProblems("engines.claude.fallback", [{ engine: "opencode", model: "mystery/x" }, { engine: "opencode", model: "go-b/beta" }], ctx)).toEqual([
      `engines.claude.fallback[0]: provider "mystery" is not in opencode's catalogue or engines.opencode.accounts`,
      `engines.claude.fallback[1]: model "go-b/beta" is not served by account "b"`,
    ]);
  });
});
