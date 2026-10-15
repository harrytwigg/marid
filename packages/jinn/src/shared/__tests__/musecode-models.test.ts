import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JinnConfig } from "../types.js";
import { discoverMusecodeModels, knownMusecodeModels, parseMusecodeModelList, resolveMusecodeCatalog } from "../musecode-models.js";
import { getModelRegistry, invalidateModelRegistry, musecodeModelCost, refreshMusecodeModels } from "../models.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engines", "__tests__", "fixtures", "fake-muse.mjs");

const row = (over: Record<string, unknown>) => ({ displayLabel: "X", isDefault: false, variants: ["none", "low", "high"], contextLimit: null, cost: null, ...over });

describe("parseMusecodeModelList", () => {
  it("maps a catalog row: label, default, efforts without none, context, cost", () => {
    const found = parseMusecodeModelList({
      models: [
        row({ modelId: "m-1", displayLabel: "Model One", isDefault: true, contextLimit: 262144, cost: { input: "1.50", cached: "0.15", output: "7.50", currency: null } }),
        row({ modelId: "m-2" }),
      ],
    });
    expect(found.defaultModel).toBe("m-1");
    expect(found.models[0]).toEqual({ id: "m-1", label: "Model One", supportsEffort: true, effortLevels: ["low", "high"], contextWindow: 262144 });
    expect(found.models[1]).not.toHaveProperty("contextWindow");
    expect(found.costs).toEqual({ "m-1": { input: 1.5, cached: 0.15, output: 7.5 } });
  });

  it("prices nothing from a partial, malformed or non-USD cost block", () => {
    const found = parseMusecodeModelList({
      models: [
        row({ modelId: "partial", cost: { input: "1", output: "2" } }),
        row({ modelId: "junk", cost: { input: "x", cached: "1", output: "2" } }),
        row({ modelId: "euro", cost: { input: "1", cached: "1", output: "2", currency: "EUR" } }),
        row({ modelId: "usd", cost: { input: "1", cached: "0", output: "2", currency: "USD" } }),
      ],
    });
    expect(Object.keys(found.costs)).toEqual(["usd"]);
  });

  it("offers no effort when the host says the capability is unknown, and the default vocabulary when it says nothing", () => {
    const found = parseMusecodeModelList({ models: [row({ modelId: "a", variants: "unknown" }), row({ modelId: "b", variants: undefined })] });
    expect(found.models[0]).toMatchObject({ supportsEffort: false, effortLevels: [] });
    expect(found.models[1]!.effortLevels).toContain("medium");
  });

  it("skips rows without an id and answers nothing for a result that is not a catalog", () => {
    expect(parseMusecodeModelList({ models: [row({ modelId: "" }), { displayLabel: "no id" }, null] }).models).toEqual([]);
    expect(parseMusecodeModelList(undefined).models).toEqual([]);
  });
});

describe("knownMusecodeModels", () => {
  it("lists the four documented models with muse-spark-1.2 the default", () => {
    const known = knownMusecodeModels();
    expect(known.models.map((m) => m.id)).toEqual(["muse-spark-1.3", "muse-spark-1.3-contributor", "muse-spark-1.2", "muse-spark-1.2-contributor"]);
    expect(known.defaultModel).toBe("muse-spark-1.2");
  });

  it("keeps a pinned model the list does not name selectable, and default", () => {
    const known = knownMusecodeModels("muse-next");
    expect(known.models[0]!.id).toBe("muse-next");
    expect(known.defaultModel).toBe("muse-next");
  });
});

describe("resolveMusecodeCatalog", () => {
  const discovered = parseMusecodeModelList({ models: [row({ modelId: "a" }), row({ modelId: "b", isDefault: true })] });
  it("prefers a pinned model, then the catalog's default, then the first", () => {
    expect(resolveMusecodeCatalog(discovered, "a").defaultModel).toBe("a");
    expect(resolveMusecodeCatalog(discovered, undefined).defaultModel).toBe("b");
    expect(resolveMusecodeCatalog({ ...discovered, defaultModel: undefined }, undefined).defaultModel).toBe("a");
  });
  it("adds a pinned model the catalog lacks", () => {
    expect(resolveMusecodeCatalog(discovered, "zz").models.map((m) => m.id)).toEqual(["zz", "a", "b"]);
  });
  it("falls back to the documented models with no catalog", () => {
    expect(resolveMusecodeCatalog(null, undefined).models).toHaveLength(4);
  });
});

describe("discoverMusecodeModels", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musecode-models-"));
    vi.stubEnv("FAKE_MUSE_STATE_DIR", path.join(tmp, "state"));
    vi.stubEnv("FAKE_MUSE_LOG", path.join(tmp, "requests.jsonl"));
    for (const name of ["FAKE_MUSE_MODELS", "FAKE_MUSE_BOOT_EXIT"]) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const requests = () => fs.readFileSync(path.join(tmp, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

  it("initializes a host, asks model/list and maps the rows", async () => {
    const found = await discoverMusecodeModels(FAKE);
    expect(found.defaultModel).toBe("muse-spark-1.3");
    expect(found.models.map((m) => m.id)).toEqual(["muse-spark-1.3", "muse-spark-1.2"]);
    expect(found.models[0]!.effortLevels).not.toContain("none");
    expect(found.costs["muse-spark-1.3"]).toEqual({ input: 1.5, cached: 0.15, output: 7.5 });
    expect(found.costs["muse-spark-1.2"]).toBeUndefined();
    const sent = requests();
    expect(sent[0]).toMatchObject({ start: true, argv: expect.arrayContaining(["serve", "--disable-sandbox"]) });
    expect(sent.filter((r) => r.method).map((r) => r.method)).toEqual(["initialize", "initialized", "model/list"]);
  });

  it("starts the host with the operator's cliFlags", async () => {
    await discoverMusecodeModels(FAKE, { cliFlags: ["--provider", "echo"] });
    expect(requests()[0]!.argv.slice(-2)).toEqual(["--provider", "echo"]);
  });

  it("never throws: a failing request, a silent host, a host that will not start and a missing binary are no models", async () => {
    vi.stubEnv("FAKE_MUSE_MODELS", "error");
    expect((await discoverMusecodeModels(FAKE)).models).toEqual([]);
    vi.stubEnv("FAKE_MUSE_MODELS", "hang");
    const started = Date.now();
    expect((await discoverMusecodeModels(FAKE, { timeoutMs: 300 })).models).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
    vi.stubEnv("FAKE_MUSE_MODELS", "");
    vi.stubEnv("FAKE_MUSE_BOOT_EXIT", "3");
    expect((await discoverMusecodeModels(FAKE)).models).toEqual([]);
    expect((await discoverMusecodeModels(path.join(tmp, "no-such-muse"))).models).toEqual([]);
  });
});

describe("the registry's Muse Code entry", () => {
  let tmp: string;
  const config = (bin: string, model?: string) => ({ engines: { default: "claude", musecode: { bin, ...(model ? { model } : {}) } } }) as unknown as JinnConfig;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musecode-registry-"));
    vi.stubEnv("FAKE_MUSE_STATE_DIR", path.join(tmp, "state"));
    vi.stubEnv("FAKE_MUSE_MODELS", "");
  });
  afterEach(async () => {
    // Discovery against a missing binary clears the snapshot.
    await refreshMusecodeModels(config(path.join(tmp, "gone")));
    invalidateModelRegistry();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("serves the documented models until discovery has run, then the host's catalog", async () => {
    const cfg = config(FAKE);
    invalidateModelRegistry();
    expect(getModelRegistry(cfg).musecode!.models.map((m) => m.id)).toContain("muse-spark-1.2-contributor");
    expect(getModelRegistry(cfg).musecode!.defaultModel).toBe("muse-spark-1.2");
    expect(musecodeModelCost("muse-spark-1.3")).toBeUndefined();

    await refreshMusecodeModels(cfg);
    const entry = getModelRegistry(cfg).musecode!;
    expect(entry.models.map((m) => m.id)).toEqual(["muse-spark-1.3", "muse-spark-1.2"]);
    expect(entry.defaultModel).toBe("muse-spark-1.3");
    expect(entry.models[0]).toMatchObject({ label: "Muse Spark 1.3", contextWindow: 262144 });
    expect(entry.effortMechanism).toBe("musecode-turn");
    expect(musecodeModelCost("muse-spark-1.3")).toEqual({ input: 1.5, cached: 0.15, output: 7.5 });
    expect(musecodeModelCost(undefined)).toEqual({ input: 1.5, cached: 0.15, output: 7.5 });
    expect(musecodeModelCost("muse-spark-1.2")).toBeUndefined();
  });

  it("keeps the documented models when discovery finds nothing", async () => {
    vi.stubEnv("FAKE_MUSE_MODELS", JSON.stringify({ models: [], profileId: "tbh", providerId: "meta", source: "bundledCatalog" }));
    const cfg = config(FAKE, "muse-spark-1.2");
    await refreshMusecodeModels(cfg);
    expect(getModelRegistry(cfg).musecode!.models).toHaveLength(4);
    expect(musecodeModelCost(undefined)).toBeUndefined();
  });
});
