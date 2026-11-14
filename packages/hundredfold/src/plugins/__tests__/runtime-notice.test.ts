import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// HUNDREDFOLD_HOME before anything reaches paths.js, which reads it once. Starting the
// runtime pulls in the stores behind the typed host verbs, and they resolve their
// databases from it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-plugin-runtime-"));
process.env.HUNDREDFOLD_HOME = tmpHome;

type Runtime = typeof import("../runtime.js");
type Host = typeof import("../host/index.js");

let runtime: Runtime;
let host: Host;

beforeAll(async () => {
  runtime = await import("../runtime.js");
  host = await import("../host/index.js");
});

// The host gateway is a module-level singleton every suite in this worker shares,
// so a runtime left running here would answer notices raised in another file.
afterAll(async () => {
  await runtime.stopPluginRuntime();
});

/** The only parts of the gateway these paths travel: the event emitter the
 *  dashboard's socket reads from, and the connector registry. */
function gatewayApiContext(emit: ReturnType<typeof vi.fn>, connectors = new Map<string, unknown>()) {
  return { emit, connectors } as unknown as import("../../gateway/api.js").ApiContext;
}

/** No plugin is enabled, so reconciling starts no watcher and the runtime under
 *  test is exactly the gateway link. */
const noPlugins = () => ({ plugins: {} });

describe("startPluginRuntime", () => {
  it("puts a plugin's notice on the wire as the frame the dashboard listens for", async () => {
    const emit = vi.fn();
    await runtime.startPluginRuntime(gatewayApiContext(emit), noPlugins);

    host.createPluginHost("mailbox").notify("3 new messages", "warning");

    expect(emit).toHaveBeenCalledWith("plugin:notice", {
      pluginId: "mailbox",
      message: "3 new messages",
      level: "warning",
    });
  });

  /* The other half of what the runtime claims: releasing the link is what stops a
   * plugin that outlived shutdown from reaching a gateway that is gone. */
  it("leaves nothing to notify into once it has stopped", async () => {
    const emit = vi.fn();
    await runtime.startPluginRuntime(gatewayApiContext(emit), noPlugins);
    const plugin = host.createPluginHost("mailbox");
    plugin.notify("before shutdown");
    const emittedWhileRunning = emit.mock.calls.length;

    await runtime.stopPluginRuntime();
    plugin.notify("after shutdown");

    expect(emit.mock.calls.length).toBe(emittedWhileRunning);
  });

  /* A send that never landed has to come back as a refusal the caller can read:
   * `{ ok: true }` would be a lie, and a raw rejection would escape the host. */
  it("answers a send the connector rejected with the reason, not with success", async () => {
    const connectors = new Map<string, unknown>([
      ["slack", { sendMessage: async () => { throw new Error("channel_not_found"); } }],
    ]);
    await runtime.startPluginRuntime(gatewayApiContext(vi.fn(), connectors), noPlugins);

    const { requirePluginHostGateway } = await import("../host/gateway-link.js");
    const gateway = requirePluginHostGateway("connectors.send");
    const outcome = await gateway.sendConnectorMessage("slack", { channel: "C1", text: "hello" });

    expect(outcome).toEqual({ ok: false, error: "channel_not_found" });
  });
});
