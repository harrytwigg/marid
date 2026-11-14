import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import type { ServerResponse } from "node:http"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Connector } from "../../shared/types.js"

const registryHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-status-connectors-registry-"))
process.env.HUNDREDFOLD_HOME = registryHome
const dbModule = await import("../../shared/db.js");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-status-connectors-home-"))
let api: typeof import("../api.js")
let registry: typeof import("../../sessions/registry.js")

function responseCapture() {
  let status = 200
  const chunks: Buffer[] = []
  const res = {
    writeHead(code: number) { status = code; return this },
    setHeader() { return this },
    end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)) },
  } as unknown as ServerResponse
  return { res, status: () => status, text: () => Buffer.concat(chunks).toString("utf8") }
}

const context = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex", codex: {} }, portal: { portalName: "Portal" } }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token-with-at-least-thirty-two-characters",
  hundredfoldHome: home,
  emit: vi.fn(),
  sessionManager: {
    getEngine: () => ({ name: "codex", run: vi.fn() }),
    getEngines: () => new Map(),
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, state: string) => state }),
  },
} as unknown as import("../api.js").ApiContext

async function request(method: string, url: string, body?: unknown, authorized = true) {
  const encoded = body === undefined ? "" : JSON.stringify(body)
  const req = Object.assign(Readable.from(encoded ? [Buffer.from(encoded)] : []), {
    method,
    url,
    headers: {
      host: "gateway.test",
      ...(authorized ? { authorization: `Bearer ${context.gatewayAuthToken}` } : {}),
      ...(encoded ? { "content-type": "application/json" } : {}),
    },
  })
  const capture = responseCapture()
  await api.handleApiRequest(req as never, capture.res, context)
  return { status: capture.status(), body: JSON.parse(capture.text()) as Record<string, any> }
}

beforeAll(async () => {
  api = await import("../api.js")
  registry = await import("../../sessions/registry.js")
  dbModule.initDb()
}, 60_000)

beforeEach(() => {
  context.connectors.clear()
  for (const session of registry.listSessions()) registry.deleteSession(session.id)
})

function connectorStub(id: string, name: string): Connector {
  const capabilities = { threading: false, messageEdits: false, reactions: false, attachments: false }
  return {
    id,
    name,
    start: async () => {},
    stop: async () => {},
    getCapabilities: () => capabilities,
    getHealth: () => ({ status: "running", capabilities }),
    reconstructTarget: () => ({ channel: "test" }),
    sendMessage: async () => undefined,
    replyMessage: async () => undefined,
    addReaction: async () => {},
    removeReaction: async () => {},
    editMessage: async () => {},
    onMessage: () => {},
  }
}

describe("status and connector API", () => {
  it("keeps operator-chosen connector labels out of public status", async () => {
    context.connectors.set("private-support-label", connectorStub("private-support-label", "slack"))
    context.connectors.set("private-ops-label", connectorStub("private-ops-label", "telegram"))

    const status = await request("GET", "/api/status", undefined, false)

    expect(status.status).toBe(200)
    expect(Object.keys(status.body.connectors).sort()).toEqual(["slack", "telegram"])
    expect(JSON.stringify(status.body)).not.toContain("private-support-label")
    expect(JSON.stringify(status.body)).not.toContain("private-ops-label")
  })

  it("addresses the selected named WhatsApp instance when reading a QR code", async () => {
    const legacyQr = vi.fn(() => "legacy-qr")
    const supportQr = vi.fn(() => "support-qr")
    context.connectors.set("whatsapp", Object.assign(connectorStub("whatsapp", "whatsapp"), { getQrCode: legacyQr }))
    context.connectors.set("whatsapp-support", Object.assign(connectorStub("whatsapp-support", "whatsapp"), { getQrCode: supportQr }))

    const named = await request("GET", "/api/connectors/whatsapp-support/qr")

    expect(named.status).toBe(200)
    expect(named.body.qr).toMatch(/^data:image\/png;base64,/)
    expect(supportQr).toHaveBeenCalledOnce()
    expect(legacyQr).not.toHaveBeenCalled()
  })

  it("rejects HTTP connector ids outside the normalized lowercase contract", async () => {
    const invalid = await request("POST", "/api/connectors/Slack-Support/send", { channel: "C1", text: "hello" })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error).toMatch(/connector id/i)
  })
})
