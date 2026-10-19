import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { discoverOpencodeModels, parseOpencodeModels } from "../opencode-models.js";
import { parseOpencodeApiModels } from "../opencode-model-records.js";

/** `opencode models --verbose` on 1.19.0, cut to three models. */
const VERBOSE = fs.readFileSync(path.join(__dirname, "fixtures", "opencode-models-verbose.txt"), "utf8");

/** `opencode api model.list --standalone` on 2.0.29, cut to three models. */
const API_LIST = fs.readFileSync(path.join(__dirname, "fixtures", "opencode-api-model-list.json"), "utf8");

/**
 * What `opencode models` actually prints, and what must not reach the picker.
 *
 * The fixtures are real output from opencode 1.16.2, plus the shapes a CLI puts
 * around a list when something else is going on — an update notice, a provider
 * warning, a path in an error. A model the picker offers but opencode cannot
 * select is worse than a short list: the session starts and the turn fails.
 */
describe("parseOpencodeModels", () => {
  it("reads one provider/model per line", () => {
    const models = parseOpencodeModels([
      "opencode/big-pickle",
      "opencode/mimo-v2.5-free",
      "anthropic/claude-sonnet-5",
    ].join("\n"));

    expect(models.map((m) => m.id)).toEqual([
      "opencode/big-pickle",
      "opencode/mimo-v2.5-free",
      "anthropic/claude-sonnet-5",
    ]);
    // The label is the model half: the provider is already the grouping.
    expect(models.map((m) => m.label)).toEqual(["big-pickle", "mimo-v2.5-free", "claude-sonnet-5"]);
  });

  it("keeps the whole id when the model half has its own slashes", () => {
    // Only the FIRST slash is structural — `openrouter/meta-llama/llama-4` is
    // one model, and handing back anything shorter would select a different one.
    const models = parseOpencodeModels("openrouter/meta-llama/llama-4\n");
    expect(models).toEqual([
      { id: "openrouter/meta-llama/llama-4", label: "meta-llama/llama-4", supportsEffort: false, effortLevels: [] },
    ]);
  });

  it("claims no effort support for a model the plain list names", () => {
    // Plain `opencode models` has no records, so no variants: an effort picker
    // that silently changes nothing is worse than none at all.
    const models = parseOpencodeModels("anthropic/claude-opus-5\n");
    expect(models[0]).toMatchObject({ supportsEffort: false, effortLevels: [] });
  });

  it("drops everything that is not a model line", () => {
    const models = parseOpencodeModels([
      "",
      "  ",
      "Update available: 1.17.0",
      "/var/lib/opencode/log/2026-09-11.log",
      "warning: provider anthropic is not authenticated",
      "opencode/big-pickle",
    ].join("\n"));

    expect(models.map((m) => m.id)).toEqual(["opencode/big-pickle"]);
  });

  it("strips ANSI colour before matching", () => {
    const models = parseOpencodeModels("\u001b[32mopencode/big-pickle\u001b[0m\n");
    expect(models.map((m) => m.id)).toEqual(["opencode/big-pickle"]);
  });

  it("keeps the first of a repeated id", () => {
    const models = parseOpencodeModels("opencode/big-pickle\nopencode/big-pickle\n");
    expect(models).toHaveLength(1);
  });

  it("returns nothing for output that named no models", () => {
    // What a CLI that is installed but not signed in prints. An empty catalog
    // keeps the registry on its configured/synthesized fallback rather than
    // replacing it with nonsense.
    expect(parseOpencodeModels("no providers configured\n")).toEqual([]);
    expect(parseOpencodeModels("")).toEqual([]);
  });
});

/**
 * `--verbose` follows each model line with its record as pretty-printed JSON;
 * `limit.context` is the model's context window. Real output from 1.19.0
 * (`fixtures/opencode-models-verbose.txt`, three models).
 */
describe("parseOpencodeModels --verbose", () => {
  it("reads each model's context window from limit.context and its effort levels from variants", () => {
    expect(parseOpencodeModels(VERBOSE)).toEqual([
      { id: "opencode/big-pickle", label: "big-pickle", supportsEffort: false, effortLevels: [], contextWindow: 200000 },
      { id: "opencode/exo-free", label: "exo-free", supportsEffort: true, effortLevels: ["high"], contextWindow: 1048576 },
      { id: "opencode/step-5-preview-free", label: "step-5-preview-free", supportsEffort: true, effortLevels: ["low", "medium", "high"], contextWindow: 1000000 },
    ]);
  });

  it("still lists a model whose record is missing or has no usable limit", () => {
    const models = parseOpencodeModels([
      "opencode/bare",
      "opencode/no-limit",
      "{",
      '  "id": "no-limit"',
      "}",
      "opencode/zero",
      "{",
      '  "limit": { "context": 0 }',
      "}",
      "opencode/text",
      "{",
      '  "limit": { "context": "200000" }',
      "}",
    ].join("\n"));
    expect(models.map((m) => m.id)).toEqual(["opencode/bare", "opencode/no-limit", "opencode/zero", "opencode/text"]);
    expect(models.some((m) => m.contextWindow !== undefined)).toBe(false);
  });

  it("gives a model with bad JSON no window and does not lose its neighbours", () => {
    const models = parseOpencodeModels([
      "opencode/broken",
      "{",
      '  "limit": { "context": 5',
      "}",
      "opencode/after",
      "{",
      '  "limit": { "context": 8000 }',
      "}",
    ].join("\n"));
    expect(models.map((m) => [m.id, m.contextWindow])).toEqual([["opencode/broken", undefined], ["opencode/after", 8000]]);
  });

  it("treats a model line at column 0 as the end of a cut-off record", () => {
    const models = parseOpencodeModels([
      "opencode/cut",
      "{",
      '  "limit": {',
      "opencode/next",
      "{",
      '  "limit": { "context": 4096 }',
      "}",
    ].join("\n"));
    expect(models.map((m) => [m.id, m.contextWindow])).toEqual([["opencode/cut", undefined], ["opencode/next", 4096]]);
  });

  it("keeps the first record of a repeated id and ignores the second", () => {
    const record = (n: number) => `{\n  "limit": { "context": ${n} }\n}`;
    const models = parseOpencodeModels(`opencode/dup\n${record(1000)}\nopencode/dup\n${record(2000)}\n`);
    expect(models).toHaveLength(1);
    expect(models[0].contextWindow).toBe(1000);
  });

  it("is not thrown by stray lines, colour codes or CRLF around the records", () => {
    const models = parseOpencodeModels([
      "Update available: 9.9.9",
      "\u001b[32mopencode/colour\u001b[0m\r",
      "{\r",
      '  "limit": { "context": 32000 }\r',
      "}\r",
      "warning: something",
    ].join("\n"));
    expect(models).toEqual([
      { id: "opencode/colour", label: "colour", supportsEffort: false, effortLevels: [], contextWindow: 32000 },
    ]);
  });

  describe("variants", () => {
    const withVariants = (variants: string) => parseOpencodeModels(`opencode/m\n{\n  "variants": ${variants}\n}\n`)[0];

    it("takes an object's keys as the levels, in opencode's order", () => {
      expect(withVariants('{ "minimal": {}, "high": {}, "low": {} }')).toMatchObject({ supportsEffort: true, effortLevels: ["minimal", "high", "low"] });
    });

    it("takes an array of {id} (the 2.x shape) the same way", () => {
      expect(withVariants('[{ "id": "low" }, { "id": "high" }, { "id": "low" }, { "id": "" }, { "name": "x" }, null]'))
        .toMatchObject({ supportsEffort: true, effortLevels: ["low", "high"] });
    });

    it("means no effort when variants is empty, null, missing or of another shape", () => {
      for (const variants of ["{}", "[]", "null", '"high"', "7"]) {
        expect(withVariants(variants)).toMatchObject({ supportsEffort: false, effortLevels: [] });
      }
      expect(parseOpencodeModels('opencode/m\n{\n  "id": "m"\n}\n')[0]).toMatchObject({ supportsEffort: false, effortLevels: [] });
    });

    it("keeps a model's variants when its window is unusable", () => {
      const model = parseOpencodeModels('opencode/m\n{\n  "limit": { "context": 0 },\n  "variants": { "high": {} }\n}\n')[0];
      expect(model).toEqual({ id: "opencode/m", label: "m", supportsEffort: true, effortLevels: ["high"] });
    });
  });

  it("still parses plain `opencode models` output, with no windows", () => {
    expect(parseOpencodeModels("opencode/a\nopencode/b\n").every((m) => m.contextWindow === undefined)).toBe(true);
  });
});

describe("parseOpencodeApiModels", () => {
  const list = (...data: unknown[]) => JSON.stringify({ location: { directory: "/w" }, data });

  it("reads each model's window and variants from a real 2.x answer, in id order", () => {
    expect(parseOpencodeApiModels(API_LIST)).toEqual([
      { id: "opencode/big-pickle", label: "big-pickle", supportsEffort: false, effortLevels: [], contextWindow: 200000 },
      { id: "opencode/deepseek-v4.1-flash-free", label: "deepseek-v4.1-flash-free", supportsEffort: true, effortLevels: ["low", "high", "max"], contextWindow: 200000 },
      { id: "opencode/space-bunny-free", label: "space-bunny-free", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"], contextWindow: 1048576 },
    ]);
  });

  it("keeps the whole id when the model half has its own slashes", () => {
    expect(parseOpencodeApiModels(list({ providerID: "openrouter", id: "meta-llama/llama-4", variants: [] }))[0])
      .toEqual({ id: "openrouter/meta-llama/llama-4", label: "meta-llama/llama-4", supportsEffort: false, effortLevels: [] });
  });

  it("leaves out a disabled model, a record without ids, an id with whitespace and a repeat", () => {
    const models = parseOpencodeApiModels(list(
      { providerID: "p", id: "off", enabled: false, variants: [{ id: "high" }] },
      { providerID: "p", id: "on", enabled: true, variants: [{ id: "high" }] },
      { providerID: "p" },
      { id: "orphan" },
      { providerID: "p", id: "has space" },
      { providerID: "p", id: "on", variants: [{ id: "low" }] },
      null,
      "p/string",
    ));
    expect(models).toEqual([{ id: "p/on", label: "on", supportsEffort: true, effortLevels: ["high"] }]);
  });

  it("gives no models for output that is not the API's answer", () => {
    for (const output of ["", "not json", "[]", "null", JSON.stringify({ data: "x" }), JSON.stringify([{ providerID: "p", id: "m" }]), "opencode/plain\n"]) {
      expect(parseOpencodeApiModels(output)).toEqual([]);
    }
  });
});

describe("discoverOpencodeModels", () => {
  it("asks the CLI for `models --verbose` and returns the windows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-models-"));
    try {
      const bin = path.join(dir, "opencode");
      // Prints the fixture only for the exact arguments; anything else is the
      // plain list a build without --verbose would print.
      fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1 $2" = "models --verbose" ]; then cat "${path.join(__dirname, "fixtures", "opencode-models-verbose.txt")}"; else echo opencode/plain; fi\n`, { mode: 0o755 });
      const models = await discoverOpencodeModels(bin);
      expect(models.map((m) => m.contextWindow)).toEqual([200000, 1048576, 1000000]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
