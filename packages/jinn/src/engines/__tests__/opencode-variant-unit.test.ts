import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildOpencodeArgs, describeOpencodeLaunch } from "../opencode-protocol.js";
import { runFlagsFor } from "../opencode-launch.js";
import {
  modelWithVariant,
  runVariantOf,
  sameModelRef,
  unsupportedServerFlags,
  variantFromCliFlags,
  variantOf,
  withKnownEffort,
  withoutVariantFlags,
} from "../opencode-variant.js";
import type { EngineRunOpts } from "../../shared/types.js";
import { logger } from "../../shared/logger.js";

/**
 * The pure parts of opencode effort: which effort is sent as the variant, and
 * how each launch spells it.
 */

/** What the registry would list: a model with five variants, one with one, one with none. */
const LEVELS: Record<string, string[]> = {
  "mock/five": ["low", "medium", "high", "xhigh", "max"],
  "mock/one": ["high"],
};
const levelsOf = (model: string | undefined) => (model ? LEVELS[model] ?? [] : []);

const opts = (over: Partial<EngineRunOpts> = {}): EngineRunOpts => ({ prompt: "p", cwd: "/work", model: "mock/five", ...over });

describe("withKnownEffort", () => {
  it("keeps an effort the turn's model lists", () => {
    const given = opts({ effortLevel: "xhigh" });
    expect(withKnownEffort(given, levelsOf)).toBe(given);
  });

  it("takes off an effort the model does not list, and logs it", () => {
    expect(withKnownEffort(opts({ model: "mock/one", effortLevel: "low" }), levelsOf).effortLevel).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('effort "low" is not a variant of mock/one'));
  });

  it("takes off any effort for a model with no levels, an unlisted model and no model", () => {
    expect(withKnownEffort(opts({ model: "mock/none", effortLevel: "high" }), levelsOf).effortLevel).toBeUndefined();
    expect(withKnownEffort(opts({ model: "mock/unlisted", effortLevel: "high" }), levelsOf).effortLevel).toBeUndefined();
    expect(withKnownEffort(opts({ model: undefined, effortLevel: "high" }), levelsOf).effortLevel).toBeUndefined();
  });

  it("leaves a turn with no effort, or the default, alone", () => {
    for (const effortLevel of [undefined, "", "default"]) {
      const given = opts({ effortLevel });
      expect(variantOf(withKnownEffort(given, levelsOf))).toBeUndefined();
    }
  });
});

describe("variantFromCliFlags / variantOf", () => {
  it("reads --variant in both spellings, the last one winning", () => {
    expect(variantFromCliFlags(["--variant", "max"])).toBe("max");
    expect(variantFromCliFlags(["--variant=low"])).toBe("low");
    expect(variantFromCliFlags(["--variant", "low", "--variant=high"])).toBe("high");
    expect(variantFromCliFlags(["--agent", "x"])).toBeUndefined();
    expect(variantFromCliFlags(["--variant"])).toBeUndefined();
    // A flag is not a value.
    expect(variantFromCliFlags(["--variant", "--agent", "x"])).toBeUndefined();
    expect(variantFromCliFlags(["--variant=-x", "--variant="])).toBeUndefined();
    expect(variantFromCliFlags(undefined)).toBeUndefined();
  });

  it("prefers the operator's flag to the turn's effort", () => {
    expect(variantOf({ effortLevel: "high", cliFlags: ["--variant", "max"] })).toBe("max");
    expect(variantOf({ effortLevel: "high" })).toBe("high");
    expect(variantOf({ effortLevel: "default" })).toBeUndefined();
    expect(runVariantOf({ effortLevel: "high", cliFlags: ["--variant", "max"] })).toBeUndefined();
    expect(runVariantOf({ effortLevel: "high" })).toBe("high");
  });

  it("names the flags server mode has no equivalent for", () => {
    expect(unsupportedServerFlags(["--agent", "plan", "--variant", "high", "--variant=low"])).toEqual([]);
    expect(unsupportedServerFlags(["--agent", "plan", "--thinking", "--variant", "high"])).toEqual(["--thinking"]);
    expect(unsupportedServerFlags(undefined)).toEqual([]);
    expect(unsupportedServerFlags(["--variant", "--agent", "plan"])).toEqual([]);
    expect(withoutVariantFlags(["--a", "--variant", "x", "--variant=y", "--b", "--variant", "--c"])).toEqual(["--a", "--b", "--c"]);
  });
});

describe("sameModelRef", () => {
  const want = { providerID: "mock", id: "five" };
  it("treats a missing, empty or \"default\" variant as none, as the 2.x server reports it", () => {
    for (const variant of [undefined, "", "default"]) expect(sameModelRef({ providerID: "mock", id: "five", variant }, want)).toBe(true);
    expect(sameModelRef({ providerID: "mock", id: "five", variant: "high" }, want)).toBe(false);
    expect(sameModelRef({ providerID: "mock", id: "five", variant: "high" }, { ...want, variant: "high" })).toBe(true);
    expect(sameModelRef({ providerID: "mock", id: "five" }, { ...want, variant: "high" })).toBe(false);
    expect(sameModelRef({ providerID: "mock", id: "other" }, want)).toBe(false);
    expect(sameModelRef(undefined, want)).toBe(false);
  });
});

describe("the run argv", () => {
  const argv = (o: EngineRunOpts, api: 1 | 2 = 1) => buildOpencodeArgs(o, runFlagsFor(api));

  it("1.x: --variant after -m", () => {
    expect(argv(opts({ effortLevel: "high" }))).toEqual(["run", "--format", "json", "--dangerously-skip-permissions", "-m", "mock/five", "--variant", "high"]);
  });

  it("2.x: the variant rides on the model, and there is no --variant", () => {
    const args = argv(opts({ effortLevel: "high", resumeSessionId: "ses_1" }), 2);
    expect(args).toEqual(["run", "--format", "json", "--dangerously-skip-permissions", "--standalone", "-m", "mock/five#high", "-s", "ses_1"]);
    expect(args).not.toContain("--variant");
  });

  it("sends none for no effort, the default, or no model", () => {
    for (const effortLevel of [undefined, "default", ""]) {
      expect(argv(opts({ effortLevel }))).toEqual(["run", "--format", "json", "--dangerously-skip-permissions", "-m", "mock/five"]);
      expect(argv(opts({ effortLevel }), 2)).toContain("mock/five");
    }
    expect(argv(opts({ model: undefined, effortLevel: "high" }))).toEqual(["run", "--format", "json", "--dangerously-skip-permissions"]);
  });

  it("lets an explicit --variant in cliFlags win: the flag on 1.x, the model's variant on 2.x, which has no such flag", () => {
    const flags = { effortLevel: "high", cliFlags: ["--variant", "max", "--agent", "plan"] };
    const one = argv(opts(flags));
    expect(one.filter((a) => a === "--variant")).toHaveLength(1);
    expect(one.slice(one.indexOf("-m"))).toEqual(["-m", "mock/five", "--variant", "max", "--agent", "plan"]);
    const two = argv(opts(flags), 2);
    expect(two).not.toContain("--variant");
    expect(two.slice(two.indexOf("-m"))).toEqual(["-m", "mock/five#max", "--agent", "plan"]);
    // Even where the model lists no effort at all.
    expect(argv(opts({ cliFlags: ["--variant=low"] }), 2)).toContain("mock/five#low");
  });

  it("is named in the launch log line", () => {
    expect(describeOpencodeLaunch(opts({ effortLevel: "high" }))).toBe("-m mock/five (variant high)");
    expect(describeOpencodeLaunch(opts())).toBe("-m mock/five");
    expect(modelWithVariant("a/b", undefined)).toBe("a/b");
  });
});
