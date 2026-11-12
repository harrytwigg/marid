import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** opencode's health is per provider: a session's switch target, and the engine list, read the provider of the model they run on, the engine's configured one when none is named. */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-switch-oc-"));
process.env.JINN_HOME = home;
const HEALTH_PATH = path.join(home, "tmp", "engine-health.json");

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const { listSwitchTargets, resolveSwitchTarget } = await import("../switch-target.js");
const registry = await import("../registry.js");
(await import("../../shared/db.js")).initDb();
import type { JinnConfig, Session } from "../../shared/types.js";

const config = {
  gateway: { port: 7797, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "opus" }, opencode: { bin: "opencode", model: "opencode-go-b/flash" } },
  models: {
    claude: { default: "opus", models: [{ id: "opus" }] },
    opencode: { default: "opencode-go-b/flash", models: [{ id: "opencode-go-b/flash" }, { id: "opencode-go/flash" }] },
  },
  connectors: {},
  logging: { file: false, stdout: false, level: "error" },
} as unknown as JinnConfig;

const session = (): Session => registry.createSession({ engine: "claude", source: "web", sourceRef: `web:t-${Math.random()}`, model: "opus" });
function exhaust(key: string) {
  const until = new Date(Date.now() + 3_600_000).toISOString();
  fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
  fs.writeFileSync(HEALTH_PATH, JSON.stringify({ [key]: { state: "exhausted", until, recheckAt: until, reason: "quota window spent" } }));
  return until;
}
const asSession = { caller: "session" } as const;
const opencodeHealth = (s: Session) => listSwitchTargets(config, s).engines.find((engine) => engine.name === "opencode")?.health;

beforeEach(() => fs.rmSync(HEALTH_PATH, { force: true }));

describe("the engine list", () => {
  it("reads opencode out when the provider of its configured model is", () => {
    const until = exhaust("opencode/opencode-go-b");
    expect(opencodeHealth(session())).toEqual({ state: "exhausted", until });
  });

  it("reads it out for the engine-wide key, and ok for another provider", () => {
    exhaust("opencode");
    expect(opencodeHealth(session())).toMatchObject({ state: "exhausted" });
    exhaust("opencode/opencode-go");
    expect(opencodeHealth(session())).toEqual({ state: "ok" });
  });
});

describe("a switch to opencode", () => {
  it("naming no model is refused when the configured model's provider is spent", () => {
    const until = exhaust("opencode/opencode-go-b");
    const result = resolveSwitchTarget(config, session(), { engine: "opencode" }, asSession);
    expect(result).toMatchObject({ ok: false, code: "target-exhausted" });
    expect(JSON.stringify(result)).toContain(until);
  });

  it("naming a model on another provider is accepted, and one on the spent provider is refused", () => {
    exhaust("opencode/opencode-go-b");
    expect(resolveSwitchTarget(config, session(), { engine: "opencode", model: "opencode-go/flash" }, asSession).ok).toBe(true);
    expect(resolveSwitchTarget(config, session(), { engine: "opencode", model: "opencode-go-b/flash" }, asSession)).toMatchObject({ ok: false, code: "target-exhausted" });
  });
});
