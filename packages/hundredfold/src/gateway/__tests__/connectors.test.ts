import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { connectorInstancesFromConfig, createConnector, reloadConnectorRegistry, startConnectorInstances } from "../server.js";
import { SlackConnector } from "../../connectors/slack/index.js";
import { DiscordConnector } from "../../connectors/discord/index.js";
import { TelegramConnector } from "../../connectors/telegram/index.js";
import { WhatsAppConnector } from "../../connectors/whatsapp/index.js";
import { SessionManager } from "../../sessions/manager.js";
import type { Connector, HundredfoldConfig } from "../../shared/types.js";

const configWith = (connectors: Record<string, any>, stt?: HundredfoldConfig["stt"]): HundredfoldConfig =>
  ({ connectors, stt }) as unknown as HundredfoldConfig;

const mixedConfig = configWith({
  slack: { appToken: "xapp-test", botToken: "xoxb-test", employee: "a-lead" },
  telegram: { botToken: "tg-test" },
  instances: [{ id: "slack-second", type: "slack", employee: "b-lead", appToken: "xapp-2", botToken: "xoxb-2" }],
});

describe("connectorInstancesFromConfig", () => {
  it("defaults legacy top-level connector ids to their type and appends instances[]", () => {
    const normalized = connectorInstancesFromConfig(mixedConfig);
    expect(normalized.map((entry) => [entry.id, entry.type])).toEqual([
      ["slack", "slack"],
      ["telegram", "telegram"],
      ["slack-second", "slack"],
    ]);
    expect(normalized[0].employee).toBe("a-lead");
    expect(normalized[0].config.id).toBe("slack");
    expect(normalized[2].employee).toBe("b-lead");
  });

  it("respects the per-type enable guards", () => {
    const ids = (config: HundredfoldConfig): string[] => connectorInstancesFromConfig(config).map((entry) => entry.id);
    expect(ids(configWith({ slack: { appToken: "xapp-test" } }))).toEqual([]);
    expect(ids(configWith({ discord: { botToken: "t" } }))).toEqual(["discord"]);
    expect(ids(configWith({ discord: { channelId: "c1" } }))).toEqual([]);
    expect(ids(configWith({ telegram: { allowFrom: [1] } }))).toEqual([]);
    expect(ids(configWith({ whatsapp: {} }))).toEqual(["whatsapp"]);
  });

  it("forwards global stt settings to telegram connectors", () => {
    const stt = { enabled: true, model: "test-model" };
    const normalized = connectorInstancesFromConfig(configWith({ telegram: { botToken: "tg-test" } }, stt));
    expect(normalized[0].config.stt).toEqual(stt);
  });

  it("skips instances without id or type, and duplicate ids", () => {
    const normalized = connectorInstancesFromConfig(
      configWith({
        slack: { appToken: "xapp-test", botToken: "xoxb-test" },
        instances: [
          { type: "slack", appToken: "a", botToken: "b" },
          { id: "no-type" },
          { id: "slack", type: "slack", appToken: "a", botToken: "b" },
          { id: "telegram-support", type: "telegram", botToken: "tg-2" },
        ],
      }),
    );
    expect(normalized.map((entry) => entry.id)).toEqual(["slack", "telegram-support"]);
  });

  it.each([
    "",
    "Slack-Support",
    "slack support",
    "-slack",
    "_slack",
    `s${"x".repeat(64)}`,
  ])("rejects invalid connector instance id %j during normalization", (id) => {
    expect(() => connectorInstancesFromConfig(configWith({
      instances: [{ id, type: "slack", appToken: "xapp-test", botToken: "xoxb-test" }],
    }))).toThrow(/invalid connector instance id/i);
  });

  it("accepts the 64-character lowercase connector id boundary", () => {
    const id = `s${"x".repeat(63)}`;
    expect(connectorInstancesFromConfig(configWith({
      instances: [{ id, type: "slack", appToken: "xapp-test", botToken: "xoxb-test" }],
    }))[0].id).toBe(id);
  });
});

describe("createConnector", () => {
  const build = (type: string, config: Record<string, unknown> = {}): Connector =>
    createConnector({ id: `${type}-1`, type, config: { ...config, id: `${type}-1` } });

  it("dispatches every supported type to its connector class", () => {
    expect(build("slack", { appToken: "xapp-test", botToken: "xoxb-test" })).toBeInstanceOf(SlackConnector);
    expect(build("discord", { botToken: "d-test" })).toBeInstanceOf(DiscordConnector);
    expect(build("telegram", { botToken: "tg-test" })).toBeInstanceOf(TelegramConnector);
    expect(build("whatsapp")).toBeInstanceOf(WhatsAppConnector);
  });

  it("carries the instance id on id while name stays the type literal", () => {
    const slack = build("slack", { appToken: "xapp-test", botToken: "xoxb-test" });
    expect([slack.id, slack.name]).toEqual(["slack-1", "slack"]);
    const discord = build("discord", { botToken: "d-test" });
    expect([discord.id, discord.name]).toEqual(["discord-1", "discord"]);
  });

  it("rejects an unknown type", () => {
    expect(() => build("carrier-pigeon")).toThrow(/Unknown connector type "carrier-pigeon"/);
  });
});

describe("connector wiring", () => {
  const stubConnector = (start: () => Promise<void>): Connector =>
    ({ name: "stub", start, stop: async () => {}, sendMessage: async () => undefined, onMessage: () => {} }) as unknown as Connector;

  it("starts every connector without awaiting one, so a hung handshake cannot block boot", () => {
    const started: string[] = [];
    const hungHandshake = new Promise<void>(() => {});
    startConnectorInstances(
      connectorInstancesFromConfig(mixedConfig),
      async (instance) => {
        started.push(instance.id);
        await hungHandshake;
      },
      (instance) => `connector "${instance.id}"`,
    );
    // Control is back here with all three handshakes still pending — that is what lets boot reach listen().
    started.push("listening");
    expect(started).toEqual(["slack", "telegram", "slack-second", "listening"]);
  });

  it("boots connectors through that starter instead of awaiting them inline", () => {
    const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    expect(source).toMatch(/\bstartConnectorInstances\(connectorInstancesFromConfig\(config\)/);
    expect(source).not.toMatch(/await\s+startConnectorInstances/);
  });

  it("keeps a rejecting start() from throwing into the boot path", async () => {
    const failing = stubConnector(async () => {
      throw new Error("handshake refused");
    });
    let logged: string | undefined;
    expect(() => {
      failing.start().catch((err: unknown) => {
        logged = err instanceof Error ? err.message : String(err);
      });
    }).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logged).toBe("handshake refused");
  });

  it("derives session-context connector names from the live registry", () => {
    const registry = new Map<string, Connector>();
    for (const instance of connectorInstancesFromConfig(mixedConfig)) {
      registry.set(instance.id, stubConnector(async () => {}));
    }
    const manager = new SessionManager(mixedConfig, new Map(), "connector-names-boot");
    manager.setConnectorProvider(() => registry);
    const names = (): string[] => (manager as any).connectorNames();

    expect(names()).toEqual(["slack", "telegram", "slack-second"]);

    // A reload replaces the registry contents; the context list must follow.
    registry.delete("telegram");
    registry.set("discord-ops", stubConnector(async () => {}));
    expect(names()).toEqual(["slack", "slack-second", "discord-ops"]);
  });

  it("rejects an invalid reload config before stopping or deleting live connectors", async () => {
    const stop = vi.fn(async () => {});
    const live = {
      id: "telegram",
      name: "telegram",
      start: async () => {},
      stop,
      sendMessage: async () => undefined,
      onMessage: () => {},
    } as unknown as Connector;
    const registry = new Map<string, Connector>([[live.id, live]]);

    await expect(reloadConnectorRegistry({
      connectorMap: registry,
      loadInstances: () => connectorInstancesFromConfig(configWith({
        instances: [{ id: "Invalid ID", type: "telegram", botToken: "tg-new" }],
      })),
      initConnector: async () => {},
      describeConnector: (instance) => `connector "${instance.id}"`,
    })).rejects.toThrow(/invalid connector instance id/i);

    expect(stop).not.toHaveBeenCalled();
    expect([...registry.entries()]).toEqual([["telegram", live]]);
  });
});
