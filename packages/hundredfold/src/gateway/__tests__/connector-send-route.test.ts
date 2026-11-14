import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector } from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-connector-send-home-"));
process.env.HUNDREDFOLD_HOME = home;
const api = await import("../api.js");

function responseCapture() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number) { status = code; return this },
    setHeader() { return this },
    end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)) },
  } as unknown as ServerResponse;
  return { res, status: () => status, text: () => Buffer.concat(chunks).toString("utf8") };
}

const context = {
  getConfig: () => ({ gateway: {} }),
  connectors: new Map<string, Connector>(),
  gatewayAuthToken: "test-token-with-at-least-thirty-two-characters",
} as unknown as import("../api.js").ApiContext;

async function send(name: string, body: unknown) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: `/api/connectors/${name}/send`,
    headers: {
      host: "gateway.test",
      authorization: `Bearer ${context.gatewayAuthToken}`,
      "content-type": "application/json",
    },
  });
  const capture = responseCapture();
  await api.handleApiRequest(req as never, capture.res, context);
  return { status: capture.status(), body: JSON.parse(capture.text()) as Record<string, any> };
}

/** `sendMessage` resolves = delivered, rejects = the message did not land. */
function connectorStub(id: string, sendMessage: Connector["sendMessage"]): Connector {
  const capabilities = { threading: false, messageEdits: false, reactions: false, attachments: false };
  const noop = async () => {};
  return {
    id, name: "slack", sendMessage,
    start: noop, stop: noop, addReaction: noop, removeReaction: noop, editMessage: noop,
    replyMessage: async () => undefined,
    getCapabilities: () => capabilities,
    getHealth: () => ({ status: "running", capabilities }),
    reconstructTarget: () => ({ channel: "test" }),
    onMessage: () => {},
  };
}

beforeEach(() => {
  context.connectors.clear();
});

describe("POST /api/connectors/:name/send", () => {
  it("reports a rejected send as a 500 carrying the transport failure, never as sent", async () => {
    // The swallow this pins: a connector that could not deliver used to resolve
    // undefined, and the route answered `{ status: "sent" }` for a lost message.
    const sendMessage = vi.fn(async () => { throw new Error("slack_api_error: channel_not_found") });
    context.connectors.set("slack-support", connectorStub("slack-support", sendMessage));

    const failed = await send("slack-support", { channel: "C123", text: "Ready for review" });

    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe("slack_api_error: channel_not_found");
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("still reports a resolved send as sent", async () => {
    const sendMessage = vi.fn(async () => "1712345678.0001");
    context.connectors.set("slack-support", connectorStub("slack-support", sendMessage));

    const delivered = await send("slack-support", { channel: "C123", text: "Ready for review" });

    expect(delivered).toEqual({ status: 200, body: { status: "sent" } });
    expect(sendMessage).toHaveBeenCalledWith({ channel: "C123", thread: undefined }, "Ready for review");
  });
});
