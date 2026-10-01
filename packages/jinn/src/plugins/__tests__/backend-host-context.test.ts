import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginServerContext } from "../backend.js";
import {
  seedProbeHome,
  writeProbePlugin,
} from "./probe-plugin.js";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-plugin-ctx-"));
process.env.JINN_HOME = tmpHome;

/**
 * A real plugin on disk, imported by the real loader and started by the real
 * supervisor.
 *
 * Two claims are under test. First, that a plugin's two entry points are handed
 * the *same* context — a watcher and a route holding different ones would be two
 * plugins wearing one id: separate storage, separate settings, and a `host`
 * whose provenance no longer names one thing. Second, that every verb on that
 * host answers, from inside a plugin, with the shape the contract promises
 * rather than with `undefined`.
 */

interface Probe {
  registrar: PluginServerContext | null;
  watcher: PluginServerContext | null;
  started: number;
}

type Recorded = Record<string, { ok: true; value: unknown } | { ok: false; error: string }>;

function probe(): Probe {
  return (globalThis as unknown as { __pluginContextProbe: Probe }).__pluginContextProbe;
}

/** What the plugin got back, per verb. A verb that rejected fails here, naming
 *  itself and its reason, rather than surfacing later as `undefined`. */
async function verbResults(): Promise<Record<string, unknown>> {
  const recorded = await (globalThis as unknown as { __pluginHostProbe: Promise<Recorded> })
    .__pluginHostProbe;
  const failed = Object.entries(recorded)
    .filter(([, outcome]) => !outcome.ok)
    .map(([verb, outcome]) => `${verb}: ${(outcome as { error: string }).error}`);
  expect(failed).toEqual([]);
  return Object.fromEntries(
    Object.entries(recorded).map(([verb, outcome]) => [verb, (outcome as { value: unknown }).value]),
  );
}

const config = { plugins: { enabled: ["probe"] } };

let reconcilePluginWatchers: typeof import("../watcher-supervisor.js").reconcilePluginWatchers;
let stopAllPluginWatchers: typeof import("../watcher-supervisor.js").stopAllPluginWatchers;
let setPluginHostGateway: typeof import("../host/gateway-link.js").setPluginHostGateway;
let sent: { connector: string; channel: string; text: string }[];

beforeAll(async () => {
  ({ reconcilePluginWatchers, stopAllPluginWatchers } = await import("../watcher-supervisor.js"));
  ({ setPluginHostGateway } = await import("../host/gateway-link.js"));
});

beforeEach(() => {
  writeProbePlugin(tmpHome);
  seedProbeHome(tmpHome);

  sent = [];
  setPluginHostGateway({
    spawnSession: async () => ({ ok: false, error: "unused" }),
    emitNotice: () => {},
    sendConnectorMessage: async (connector, message) => {
      sent.push({ connector, channel: message.channel, text: message.text });
      return { ok: true };
    },
  });
});

afterEach(async () => {
  await stopAllPluginWatchers();
  setPluginHostGateway(null);
});

describe("the context a plugin's server module receives", () => {
  it("is one object, reaching the registrar and the watcher alike", async () => {
    await reconcilePluginWatchers(() => config);

    const { registrar, watcher, started } = probe();
    expect(started).toBe(1);
    expect(registrar).not.toBeNull();
    expect(watcher).toBe(registrar);
  });

  it("carries the typed host door, with every verb on it", async () => {
    await reconcilePluginWatchers(() => config);
    const host = probe().registrar?.host;

    const { PLUGIN_HOST_VERBS } = await import("../host/permissions.js");
    const reachable = PLUGIN_HOST_VERBS.map((verb) => {
      const [domain, name] = verb.split(".");
      const target = name
        ? (host as unknown as Record<string, Record<string, unknown>>)[domain!]?.[name]
        : (host as unknown as Record<string, unknown>)[domain!];
      return `${verb}: ${typeof target}`;
    });

    expect(reachable).toEqual(PLUGIN_HOST_VERBS.map((verb) => `${verb}: function`));
  });

  it("gives the watcher a host scoped to its own plugin", async () => {
    await reconcilePluginWatchers(() => config);

    const created = probe().watcher?.host.todos.create({ title: "minted from a watcher" });

    const store = await import("../../work-items/store.js");
    expect(store.getWorkItem(created!.id)?.createdBy).toBe("plugin:probe");
  });
});

/**
 * The verbs answering *from inside a plugin*, which is the only place that
 * proves the door is reachable rather than merely exported. The check above says
 * a property is a function; these say what came back when it was called.
 */
describe("what a plugin gets back from each new verb", () => {
  it("writes a note and reads that same note's body back", async () => {
    await reconcilePluginWatchers(() => config);
    const results = await verbResults();

    expect(results["notes.create"]).toMatchObject({
      title: "Minted by a plugin",
      body: "the body",
      folder: "",
    });
    const created = results["notes.create"] as { path: string; revision: string };
    expect(created.path).toMatch(/^knowledge\/.+\.md$/);
    expect(created.revision).toMatch(/^[a-f0-9]{64}$/);

    expect(results["notes.read"]).toMatchObject({ path: created.path, body: "the body" });
  });

  it("lists the note it minted", async () => {
    await reconcilePluginWatchers(() => config);
    const listed = (await verbResults())["notes.list"] as { title: string }[];

    expect(listed.map((note) => note.title)).toContain("Minted by a plugin");
  });

  it("searches knowledge and gets the hit with its snippet", async () => {
    await reconcilePluginWatchers(() => config);
    const hits = (await verbResults())["knowledge.search"] as {
      path: string;
      title: string;
      snippet: string;
      matchCount: number;
    }[];

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: "knowledge/birds.md", title: "Birds" });
    expect(hits[0]!.snippet).toContain("«kestrel»");
    expect(hits[0]!.matchCount).toBeGreaterThan(0);
  });

  it("sends through the named connector and resolves with nothing to read", async () => {
    await reconcilePluginWatchers(() => config);

    expect((await verbResults())["connectors.send"]).toBeUndefined();
    expect(sent).toEqual([{ connector: "slack", channel: "C1", text: "hello" }]);
  });

  /* The read tier is the point: a plugin that can list jobs still cannot read
   * what they say, exactly as `GET /api/cron` withholds it. */
  it("lists cron jobs without their prompts", async () => {
    await reconcilePluginWatchers(() => config);

    expect((await verbResults())["cron.jobs"]).toEqual([
      {
        id: "digest",
        name: "Daily digest",
        schedule: "0 9 * * *",
        enabled: true,
        employee: "a-lead",
        engine: null,
        timezone: "UTC",
      },
    ]);
  });

  it("reads run history through the same summariser the route uses", async () => {
    await reconcilePluginWatchers(() => config);

    expect((await verbResults())["cron.runs"]).toEqual([
      { status: "success", durationMs: 1200 },
    ]);
  });
});
