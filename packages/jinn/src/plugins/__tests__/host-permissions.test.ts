import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedProbeHome } from "./probe-plugin.js";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-plugin-perms-"));
process.env.JINN_HOME = tmpHome;
seedProbeHome(tmpHome);

/**
 * The gateway half of the permission seam, proved by denying one verb at a time.
 *
 * The gate is mocked rather than configured because v1 ships no denial policy —
 * the seam is the deliverable, not the policy. Mocking it is also what makes the
 * test load-bearing: a verb that never called the gate would sail through its
 * own denial and the expectation below would fail. That is the property under
 * test, not the throw itself.
 */
const denied = vi.hoisted(() => ({ verb: null as string | null }));

vi.mock("../host/permissions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../host/permissions.js")>();
  return {
    ...actual,
    assertVerbAllowed: (pluginId: string, verb: import("../host/permissions.js").PluginHostVerb) => {
      if (verb === denied.verb) throw new actual.PluginHostDeniedError(pluginId, verb);
      actual.assertVerbAllowed(pluginId, verb);
    },
  };
});

// The mock spreads the real module, so the table and the error class below are
// the real ones — only the gate is swapped. Driving `it.each` off the table
// rather than off a copy is what makes a verb added without a `callsFor` row
// fail here instead of going untested.
import { PLUGIN_HOST_VERBS, PluginHostDeniedError, type PluginHostVerb } from "../host/permissions.js";

type Permissions = typeof import("../host/permissions.js");
let createPluginHost: typeof import("../host/index.js").createPluginHost;
let setPluginHostGateway: typeof import("../host/gateway-link.js").setPluginHostGateway;

beforeAll(async () => {
  ({ createPluginHost } = await import("../host/index.js"));
  ({ setPluginHostGateway } = await import("../host/gateway-link.js"));
});

/**
 * One call per verb, so every verb in the union is exercised by name.
 *
 * The rows that need something to point at mint it here, before any verb is
 * denied, so commenting exercises `todos.comment` alone rather than failing on
 * the `todos.create` that set it up.
 */
function callsFor(pluginId: string): Record<PluginHostVerb, () => unknown> {
  const host = createPluginHost(pluginId);
  const commentable = host.todos.create({ title: "commentable" });
  const readable = host.notes.create({ title: "readable", body: "a body" });
  return {
    "todos.list": () => host.todos.list(),
    "todos.create": () => host.todos.create({ title: "a todo" }),
    "todos.comment": () => host.todos.comment(commentable.id, "noted"),
    "sessions.spawn": () => host.sessions.spawn({ prompt: "draft a reply" }),
    "employees.list": () => host.employees.list(),
    notify: () => host.notify("something happened"),
    "notes.list": () => host.notes.list(),
    "notes.read": () => host.notes.read(readable.path),
    "notes.create": () => host.notes.create({ title: "another note", body: "more" }),
    "connectors.send": () => host.connectors.send("slack", { channel: "C1", text: "hello" }),
    "cron.jobs": () => host.cron.jobs(),
    "cron.runs": () => host.cron.runs("digest"),
    "knowledge.search": () => host.knowledge.search("kestrel"),
  };
}

beforeEach(() => {
  denied.verb = null;
  setPluginHostGateway({
    spawnSession: async () => ({ ok: true, session: { id: "sess-stub" } as never, dispatched: false }),
    emitNotice: () => {},
    sendConnectorMessage: async () => ({ ok: true }),
  });
});

afterEach(() => {
  setPluginHostGateway(null);
});

describe("denying one verb", () => {
  it.each(PLUGIN_HOST_VERBS)("refuses %s and leaves the other twelve working", async (target) => {
    const calls = callsFor("mailbox");
    denied.verb = target;

    for (const verb of PLUGIN_HOST_VERBS) {
      const attempt = Promise.resolve().then(() => calls[verb]());
      if (verb === target) {
        await expect(attempt).rejects.toBeInstanceOf(PluginHostDeniedError);
        // Naming the verb is the assertion: a refusal that carried someone
        // else's verb would still be the right class.
        await expect(attempt).rejects.toMatchObject({ name: "PluginHostDeniedError", verb: target });
      } else {
        // Settling at all is the assertion: a refusal would reject, and
        // `notify` legitimately resolves to nothing.
        await expect(attempt).resolves.not.toBeInstanceOf(Error);
      }
    }
  });

  it("names the plugin and the verb on the error", async () => {
    denied.verb = "sessions.spawn";

    await expect(callsFor("mailbox")["sessions.spawn"]()).rejects.toMatchObject({
      name: "PluginHostDeniedError",
      pluginId: "mailbox",
      verb: "sessions.spawn",
    });
  });
});

describe("the v1 policy", () => {
  it("grants every verb, so nothing is refused today", async () => {
    const actual = await vi.importActual<Permissions>("../host/permissions.js");

    for (const verb of actual.PLUGIN_HOST_VERBS) {
      expect(() => actual.assertVerbAllowed("mailbox", verb)).not.toThrow();
    }
  });
});
