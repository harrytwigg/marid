import { describe, expect, it, vi } from "vitest"
import type { HundredfoldNativeBridge, NativeStreamEvent } from "@/platform/native-bridge"
import { GATEWAY_SOCKET_CLOSED, GATEWAY_SOCKET_OPEN } from "../gateway-transport"
import { createNativeGatewayTransport, pairNativeGateway } from "../native-gateway-transport"

function fakeBridge(): HundredfoldNativeBridge & { request: ReturnType<typeof vi.fn>; stream: ReturnType<typeof vi.fn> } {
  return {
    runtime: "tauri",
    pair: vi.fn(async ({ target }) => ({ origin: target.origin, device: { id: "device-a", name: "Mac app" } })),
    request: vi.fn(async () => ({ status: 200, headers: [{ name: "content-type", value: "application/json" }], bodyBase64: btoa('{"ok":true}') })),
    stream: vi.fn(async (_input: unknown, onEvent: (event: NativeStreamEvent) => void) => {
      queueMicrotask(() => onEvent({ event: "opened", streamId: "stream-1" }))
      return { streamId: "stream-1" }
    }),
    forget: vi.fn(async () => ({ localRemoved: true, remoteRevoked: true })),
  }
}

describe("native gateway transport", () => {
  it("pairs and requests through the bridge without exposing a credential", async () => {
    const bridge = fakeBridge()
    await expect(pairNativeGateway("http://127.0.0.1:7779", "ABCD-EFGH", bridge)).resolves.toEqual({
      origin: "http://127.0.0.1:7779",
      device: { id: "device-a", name: "Mac app" },
    })
    const transport = createNativeGatewayTransport("http://127.0.0.1:7779", bridge)
    await expect((await transport.request("/api/sessions")).json()).resolves.toEqual({ ok: true })
    expect(bridge.request).toHaveBeenCalledWith(expect.objectContaining({
      target: { origin: "http://127.0.0.1:7779" },
      path: "/api/sessions",
    }))
    expect(JSON.stringify(bridge.request.mock.calls)).not.toContain("cookie")
  })

  it("maps native stream events onto the socket contract", async () => {
    const bridge = fakeBridge()
    const socket = createNativeGatewayTransport("http://127.0.0.1:7779", bridge).openSocket("/ws")
    const opened = vi.fn()
    socket.onopen = opened
    await vi.waitFor(() => expect(socket.readyState).toBe(GATEWAY_SOCKET_OPEN))
    expect(opened).toHaveBeenCalledOnce()
    expect(bridge.stream).toHaveBeenCalledWith(
      { action: "open", target: { origin: "http://127.0.0.1:7779" }, path: "/ws" },
      expect.any(Function),
    )
  })

  it("closes a native stream that finishes opening after the socket was closed", async () => {
    let resolveOpen!: (receipt: { streamId: string }) => void
    const bridge = fakeBridge()
    bridge.stream.mockImplementationOnce(() => new Promise((resolve) => { resolveOpen = resolve }))
    const socket = createNativeGatewayTransport("http://127.0.0.1:7779", bridge).openSocket("/ws")

    socket.close()
    resolveOpen({ streamId: "late-stream" })

    await vi.waitFor(() => expect(bridge.stream).toHaveBeenCalledWith(
      { action: "close", streamId: "late-stream" },
      expect.any(Function),
    ))
    expect(socket.readyState).toBe(GATEWAY_SOCKET_CLOSED)
  })

  it("constructs fetch-compatible responses for statuses that cannot have a body", async () => {
    const bridge = fakeBridge()
    bridge.request.mockResolvedValueOnce({ status: 204, headers: [], bodyBase64: "" })
    const transport = createNativeGatewayTransport("http://127.0.0.1:7779", bridge)

    const response = await transport.request("/api/no-content")

    expect(response.status).toBe(204)
    await expect(response.text()).resolves.toBe("")
  })

  it("rejects full URLs and unsafe paths before IPC", async () => {
    const bridge = fakeBridge()
    const transport = createNativeGatewayTransport("http://127.0.0.1:7779", bridge)
    await expect(transport.request("http://192.168.1.4/api/sessions")).rejects.toThrow(/root-relative/)
    expect(() => transport.openSocket("//192.168.1.4/ws")).toThrow(/root-relative/)
    expect(bridge.request).not.toHaveBeenCalled()
  })
})
