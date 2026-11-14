import { describe, expect, it } from "vitest";
import type { EngineHealthReading } from "../../shared/engine-health.js";
import type { HundredfoldConfig } from "../../shared/types.js";
import { engineHeldOut } from "../snapshot.js";

/** The walk's `exhausted` for opencode: its own key, or the key of the provider its default model runs on. */

const NOW = new Date("2026-11-12T10:00:00.000Z");
const spent = { state: "exhausted" as const, until: new Date(NOW.getTime() + 3_600_000).toISOString() };
const config = (model?: string) => ({ engines: { default: "claude", opencode: { bin: "opencode", ...(model ? { model } : {}) } } }) as unknown as HundredfoldConfig;
const held = (health: EngineHealthReading, engine = "opencode", model: string | null = "opencode-go-b/flash") => engineHeldOut(health, engine, config(model ?? undefined), NOW);

describe("engineHeldOut", () => {
  it("holds opencode out when its default model's provider is spent", () => {
    expect(held({ "opencode/opencode-go-b": spent })).toBe(true);
  });

  it("keeps the engine-wide key", () => {
    expect(held({ opencode: spent })).toBe(true);
  });

  it("does not hold it out for another provider or account", () => {
    expect(held({ "opencode/opencode-go": spent, "opencode/opencode-go-c": spent })).toBe(false);
    expect(held({})).toBe(false);
  });

  it("reads no provider key when the default model names none", () => {
    expect(held({ "opencode/opencode-go-b": spent }, "opencode", "plain")).toBe(false);
    expect(held({ "opencode/opencode-go-b": spent }, "opencode", null)).toBe(false);
  });

  it("does not read opencode's provider key for another engine, and a record past its re-probe is not held", () => {
    expect(held({ "opencode/opencode-go-b": spent }, "codex")).toBe(false);
    expect(held({ "opencode/opencode-go-b": { ...spent, recheckAt: new Date(NOW.getTime() - 1000).toISOString() } })).toBe(false);
  });
});
