import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedProbeHome } from "./probe-plugin.js";

// JINN_HOME before anything reaches paths.js, which reads it once. Both the
// session registry and the Todo store resolve their databases from it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-plugin-host-"));
process.env.JINN_HOME = tmpHome;
seedProbeHome(tmpHome);

type Host = typeof import("../host/index.js");
type Link = typeof import("../host/gateway-link.js");
type Errors = typeof import("../host/errors.js");
type Store = typeof import("../../work-items/store.js");
type Registry = typeof import("../../sessions/registry.js");

let host: Host;
let link: Link;
let store: Store;
let registry: Registry;
let errors: Errors;

beforeAll(async () => {
  errors = await import("../host/errors.js");
  host = await import("../host/index.js");
  link = await import("../host/gateway-link.js");
  store = await import("../../work-items/store.js");
  registry = await import("../../sessions/registry.js");
});

afterEach(() => {
  link.setPluginHostGateway(null);
});

/** The registration seam with only the members a test cares about spelled out.
 *  The rest are the inert answers, so a stub says what it is exercising. */
function linkGateway(overrides: Partial<import("../host/gateway-link.js").PluginHostGateway>): void {
  link.setPluginHostGateway({
    spawnSession: async () => ({ ok: false, error: "unused" }),
    emitNotice: () => {},
    sendConnectorMessage: async () => ({ ok: false, error: "unused" }),
    ...overrides,
  });
}

/** The narrowest gateway `spawnSession` reads: config, an emitter, and a
 *  session manager whose engine lookup comes up empty. */
function gatewayApiContext() {
  return {
    getConfig: () => ({
      gateway: {},
      engines: { default: "codex", codex: { bin: "codex", model: "test-model" } },
      sessions: {},
      mcp: {},
    }),
    connectors: new Map(),
    startTime: Date.now(),
    emit: () => {},
    sessionManager: { getEngines: () => new Map(), getEngine: () => undefined },
  } as unknown as import("../../gateway/api.js").ApiContext;
}

describe("host.todos", () => {
  it("stamps the plugin as the Todo's creator, on the row that was persisted", () => {
    const created = host.createPluginHost("mailbox").todos.create({ title: "reply to a customer" });

    // The stored row, not the return value: provenance that only exists in
    // memory is provenance nobody can audit afterwards.
    const persisted = store.getWorkItem(created.id);
    expect(persisted?.createdBy).toBe("plugin:mailbox");
    expect(persisted?.sourceRef).toMatch(/^plugin:mailbox:/);
  });

  /* `createWorkItem` is idempotent on (source, sourceRef), so a plugin minting
   * twice under one constant ref would silently get the first Todo back both
   * times and never know it had lost the second. */
  it("gives two Todos from one plugin two rows", () => {
    const plugin = host.createPluginHost("mailbox");

    const first = plugin.todos.create({ title: "first" });
    const second = plugin.todos.create({ title: "second" });

    expect(second.id).not.toBe(first.id);
    expect(store.getWorkItem(second.id)?.title).toBe("second");
  });

  it("comments as the plugin, and lists what it created", () => {
    const plugin = host.createPluginHost("mailbox");
    const todo = plugin.todos.create({ title: "listable", assignee: "a-lead" });

    const comment = plugin.todos.comment(todo.id, "the watcher saw new mail");
    expect(comment.author).toBe("plugin:mailbox");
    expect(comment.authorKind).toBe("system");

    expect(plugin.todos.list({ assignee: "a-lead" }).map((item) => item.id)).toContain(todo.id);
  });
});

describe("host.sessions.spawn", () => {
  it("records the plugin on the session row it persisted", async () => {
    // Through the real `spawnSession`, the same one `POST /api/sessions` calls.
    // Its engine lookup finds nothing, so the turn never dispatches — and the
    // row is still written, which is the half under test.
    const { spawnSession } = await import("../../gateway/spawn-session.js");
    linkGateway({ spawnSession: (input) => spawnSession(gatewayApiContext(), input) });

    const session = await host.createPluginHost("mailbox").sessions.spawn({ prompt: "draft a reply" });

    const persisted = registry.getSession(session.id);
    expect(persisted?.source).toBe("plugin");
    expect(persisted?.sourceRef).toMatch(/^plugin:mailbox:/);
  });

  it("says the gateway is missing rather than returning a session that never started", async () => {
    await expect(host.createPluginHost("mailbox").sessions.spawn({ prompt: "hi" })).rejects.toThrow(
      /host\.sessions\.spawn needs a running gateway/,
    );
  });

  it("surfaces a refusal as a failure, not as an absent session", async () => {
    linkGateway({ spawnSession: async () => ({ ok: false as const, error: 'unknown employee "nobody"' }) });

    await expect(
      host.createPluginHost("mailbox").sessions.spawn({ prompt: "hi", employee: "nobody" }),
    ).rejects.toThrow(/unknown employee "nobody"/);
  });
});

describe("host.notify", () => {
  it("hands the dashboard the plugin, the message and the level", () => {
    const emitNotice = vi.fn();
    linkGateway({ emitNotice });

    host.createPluginHost("mailbox").notify("3 new messages", "warning");

    expect(emitNotice).toHaveBeenCalledWith("mailbox", "3 new messages", "warning");
  });

  it("defaults to info", () => {
    const emitNotice = vi.fn();
    linkGateway({ emitNotice });

    host.createPluginHost("mailbox").notify("all quiet");

    expect(emitNotice).toHaveBeenCalledWith("mailbox", "all quiet", "info");
  });

  /* A watcher runs unattended for hours. Falling over because nothing was
   * listening for a toast would take the plugin down for a side channel. */
  it("drops the notice when no gateway is registered, rather than throwing", () => {
    expect(() => host.createPluginHost("mailbox").notify("into the void")).not.toThrow();
  });

  it("absorbs a notification surface that throws", () => {
    linkGateway({
      emitNotice: () => {
        throw new Error("the socket is gone");
      },
    });

    expect(() => host.createPluginHost("mailbox").notify("still fine")).not.toThrow();
  });
});

describe("host.employees.list", () => {
  it("reads the org registry", () => {
    expect(Array.isArray(host.createPluginHost("mailbox").employees.list())).toBe(true);
  });
});

/**
 * Every way a backend verb can fail arrives as a rejection carrying the verb.
 *
 * The two below are the ones with somewhere else to go. `notes.read` could have
 * handed back the store's `{ ok: false, reason }` as a *successful* return, and
 * a plugin that forgot to narrow it would have carried on with a non-note.
 * `connectors.send` could have thrown whatever the missing gateway threw, which
 * names no verb at all.
 */
describe("a backend verb that cannot do the thing", () => {
  it("rejects a missing note rather than resolving with a NoteStoreResult", async () => {
    const attempt = () => host.createPluginHost("mailbox").notes.read("knowledge/nothing-here.md");

    expect(attempt).toThrow(errors.PluginHostError);
    expect(attempt).toThrow(/host\.notes\.read refused:/);
    try {
      attempt();
    } catch (error) {
      expect(error).toMatchObject({ verb: "notes.read", reason: "not-found" });
      // The union never reaches the caller: no `ok`, no `detail` to narrow.
      expect(error).not.toHaveProperty("ok");
    }
  });

  it("names the verb when no gateway is registered to send through", async () => {
    await expect(
      host.createPluginHost("mailbox").connectors.send("slack", { channel: "C1", text: "hi" }),
    ).rejects.toMatchObject({
      name: "PluginHostError",
      verb: "connectors.send",
      reason: "no-gateway",
    });
  });

  it("surfaces an unknown connector as a refusal, not as a send that went nowhere", async () => {
    linkGateway({ sendConnectorMessage: async () => ({ ok: false, error: 'no connector "slack"' }) });

    await expect(
      host.createPluginHost("mailbox").connectors.send("slack", { channel: "C1", text: "hi" }),
    ).rejects.toMatchObject({ name: "PluginHostError", verb: "connectors.send" });
  });
});

describe("the instance read verbs", () => {
  it("lists cron jobs without the prompt the job carries", () => {
    expect(host.createPluginHost("mailbox").cron.jobs()).toEqual([
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

  it("summarises run history the way the route does, dropping what it does not allow", async () => {
    expect(await host.createPluginHost("mailbox").cron.runs("digest")).toEqual([
      { status: "success", durationMs: 1200 },
    ]);
  });

  it("answers an empty history for a job that never ran", async () => {
    expect(await host.createPluginHost("mailbox").cron.runs("never-fired")).toEqual([]);
  });

  it("finds a knowledge file by a word inside it", () => {
    const hits = host.createPluginHost("mailbox").knowledge.search("kestrel");

    expect(hits.map((hit) => hit.path)).toEqual(["knowledge/birds.md"]);
    expect(hits[0]!.snippet).toContain("«kestrel»");
  });

  it("writes a note and reads the same body back", () => {
    const plugin = host.createPluginHost("mailbox");

    const created = plugin.notes.create({ title: "Kept", body: "the body" });
    expect(created.revision).toMatch(/^[a-f0-9]{64}$/);

    expect(plugin.notes.read(created.path).body).toBe("the body");
    expect(plugin.notes.list("Kept").map((note) => note.path)).toContain(created.path);
  });
});
