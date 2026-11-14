import { describe, expect, it, vi } from "vitest";

/** A new session for an employee who pins no model runs on the engine's configured one, and starts on the first healthy link when that model's provider (an account, say) is out. */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  getModelRegistry: () => ({}),
}));
import { rerouteAtCreation } from "../fallback-reroute.js";
import { availabilityRegistry } from "../availability-registry.js";
import { healthKeys, linkHealthKey } from "../../shared/fallback-chain-health.js";
import { sessionFallbackChain } from "../../shared/fallback-chain.js";
import type { Employee, HundredfoldConfig, Session } from "../../shared/types.js";

const NOW = new Date("2026-11-12T10:00:00.000Z");
const HOUR = 3600_000;
const spent = (hours = 3) => ({ state: "exhausted" as const, until: new Date(NOW.getTime() + hours * HOUR).toISOString(), recheckAt: new Date(NOW.getTime() + hours * HOUR).toISOString() });

const config = (model = "opencode-go-b/flash") => ({
  engines: {
    default: "opencode", claude: { bin: "claude", model: "opus" },
    opencode: {
      bin: "opencode", model,
      accounts: { "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "GO_B_KEY" }, "go-c": { provider: "opencode-go-c", base: "opencode-go", keyEnv: "GO_C_KEY" } },
    },
  },
}) as unknown as HundredfoldConfig;

const CHAIN = [{ engine: "opencode", model: "opencode-go-b/flash" }, { engine: "opencode", model: "opencode-go/flash" }, { engine: "opencode", model: "opencode-go-c/flash" }];
const unpinned = { name: "worker", engine: "opencode", fallback: CHAIN } as Employee;
const registry = availabilityRegistry({}, (name) => name === "opencode" || name === "claude");
const reroute = (over: Record<string, unknown> = {}) => rerouteAtCreation({
  config: config(), employee: unpinned, engine: "opencode", model: undefined, registry, health: {}, scope: { scoped: false, remote: false }, now: NOW, ...over,
});

describe("an unpinned opencode employee's own link", () => {
  it("is keyed by the provider of engines.opencode.model, then the engine's", () => {
    const { links } = sessionFallbackChain({
      config: config(), employee: unpinned, registry, health: {}, now: NOW,
      session: { id: "", engine: "opencode", model: null, employee: "worker", transportMeta: null, fallbackTarget: null } as unknown as Session,
    });
    expect(links[0]).toMatchObject({ engine: "opencode", healthProvider: "opencode-go-b" });
    expect(links[0]!.model).toBeUndefined();
    expect(linkHealthKey(links[0]!)).toBe("opencode/opencode-go-b");
    expect(healthKeys(links[0]!)).toEqual(["opencode/opencode-go-b", "opencode"]);
    // Only the own link is stamped: a link naming its model reads that model's provider.
    expect(links.slice(1).every((link) => link.healthProvider === undefined)).toBe(true);
  });

  it("starts on the first healthy link when its account is out, without pinning the model", () => {
    const choice = reroute({ health: { "opencode/opencode-go-b": spent() } })!;
    expect(choice).toMatchObject({ engine: "opencode", model: "opencode-go/flash", reroute: { from: "opencode", model: null, run: { source: "employee", position: 2 } } });
    expect(choice.reroute.until.getTime()).toBe(NOW.getTime() + 3 * HOUR);
  });

  it("hops past another account that is out too", () => {
    const choice = reroute({ health: { "opencode/opencode-go-b": spent(), "opencode/opencode-go": spent() } })!;
    expect(choice.model).toBe("opencode-go-c/flash");
  });

  it("stays put when only the stock provider, or another account, is out", () => {
    expect(reroute({ health: { "opencode/opencode-go": spent() } })).toBeUndefined();
    expect(reroute({ health: { "opencode/opencode-go-c": spent() } })).toBeUndefined();
  });

  it("is still out when the whole engine is", () => {
    const toClaude = { ...unpinned, fallback: [{ engine: "claude" }] } as Employee;
    expect(reroute({ health: { opencode: spent() }, employee: toClaude })).toMatchObject({ engine: "claude" });
  });

  it("follows the engine's model: a stock-provider default reads the stock provider", () => {
    expect(reroute({ config: config("opencode-go/flash"), health: { "opencode/opencode-go-b": spent() } })).toBeUndefined();
    expect(reroute({ config: config("opencode-go/flash"), health: { "opencode/opencode-go": spent() } })).toBeDefined();
  });

  it("reads only the engine-wide key when the engine's model names no provider", () => {
    const plain = config("plain-model");
    const toClaude = { ...unpinned, fallback: [{ engine: "claude" }] } as Employee;
    expect(reroute({ config: plain, employee: toClaude, health: { "opencode/opencode-go-b": spent() } })).toBeUndefined();
    expect(reroute({ config: plain, employee: toClaude, health: { opencode: spent() } })).toMatchObject({ engine: "claude" });
  });

  it("leaves a pinned employee on its own model's provider", () => {
    const pinned = { ...unpinned, model: "opencode-go/flash" } as Employee;
    expect(reroute({ employee: pinned, model: "opencode-go/flash", health: { "opencode/opencode-go-b": spent() } })).toBeUndefined();
    expect(reroute({ employee: pinned, model: "opencode-go/flash", health: { "opencode/opencode-go": spent() } })).toMatchObject({ model: "opencode-go-b/flash" });
  });
});
