import type { HundredfoldNativeBridge, NativeStreamEvent } from "@/platform/native-bridge"
import {
  GATEWAY_SOCKET_CLOSED,
  GATEWAY_SOCKET_CLOSING,
  GATEWAY_SOCKET_CONNECTING,
  GATEWAY_SOCKET_OPEN,
  type GatewaySocketConnection,
  type GatewayTransport,
} from "./gateway-transport"

function gatewayOrigin(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid native gateway origin")
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Native gateway profiles require a bare origin")
  }
  return url.origin
}

function gatewayPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#")) {
    throw new Error(`Gateway paths must be safe and root-relative: ${path}`)
  }
  return path
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function encodeBody(body: BodyInit | null | undefined): Promise<{ bodyBase64?: string; contentType?: string }> {
  if (body == null) return {}
  const response = new Response(body)
  return {
    bodyBase64: bytesToBase64(new Uint8Array(await response.arrayBuffer())),
    contentType: response.headers.get("content-type") ?? undefined,
  }
}

function closeEvent(code = 1006, reason = ""): CloseEvent {
  if (typeof CloseEvent === "function") return new CloseEvent("close", { code, reason })
  const event = new Event("close") as CloseEvent
  Object.defineProperties(event, { code: { value: code }, reason: { value: reason } })
  return event
}

function responseBody(method: string, status: number, bodyBase64: string): Uint8Array<ArrayBuffer> | null {
  if (method.toUpperCase() === "HEAD" || [204, 205, 304].includes(status)) return null
  return base64ToBytes(bodyBase64)
}

class NativeGatewaySocket implements GatewaySocketConnection {
  readyState = GATEWAY_SOCKET_CONNECTING
  binaryType: BinaryType = "blob"
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readonly #listeners = new Set<(event: MessageEvent) => void>()
  #streamId: string | undefined
  #closed = false

  constructor(private readonly bridge: HundredfoldNativeBridge, origin: string, path: string) {
    void bridge.stream({ action: "open", target: { origin }, path }, (event) => this.#receive(event))
      .then(({ streamId }) => {
        this.#streamId = streamId
        if (this.#closed) {
          return bridge.stream({ action: "close", streamId }, () => {})
            .finally(() => this.#finish(1000, ""))
        }
      })
      .catch(() => this.#fail())
  }

  addEventListener(type: "message", listener: (event: MessageEvent) => void): void {
    if (type === "message") this.#listeners.add(listener)
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== GATEWAY_SOCKET_OPEN || !this.#streamId) throw new DOMException("Socket is not open", "InvalidStateError")
    const streamId = this.#streamId
    if (typeof data === "string") {
      void this.bridge.stream({ action: "send", streamId, text: data }, () => {}).catch(() => this.#fail())
      return
    }
    void (async () => {
      const bytes = data instanceof Blob
        ? new Uint8Array(await data.arrayBuffer())
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data)
      await this.bridge.stream({ action: "send", streamId, bytesBase64: bytesToBase64(bytes) }, () => {})
    })().catch(() => this.#fail())
  }

  close(): void {
    if (this.readyState === GATEWAY_SOCKET_CLOSED || this.readyState === GATEWAY_SOCKET_CLOSING) return
    this.#closed = true
    this.readyState = GATEWAY_SOCKET_CLOSING
    if (!this.#streamId) return
    void this.bridge.stream({ action: "close", streamId: this.#streamId }, () => {})
      .finally(() => this.#finish(1000, ""))
  }

  #receive(event: NativeStreamEvent): void {
    if (this.#closed && event.event !== "closed") return
    if (event.event === "opened") {
      this.#opened(event.streamId)
      return
    }
    if (event.event === "message") {
      this.#deliver(event)
      return
    }
    if (event.event === "failed") {
      this.#fail()
      return
    }
    this.#finish(event.code ?? 1000, event.reason)
  }

  #opened(streamId: string): void {
    this.#streamId = streamId
    this.readyState = GATEWAY_SOCKET_OPEN
    this.onopen?.(new Event("open"))
  }

  #deliver(event: Extract<NativeStreamEvent, { event: "message" }>): void {
    const bytes = event.bytesBase64 === undefined ? undefined : base64ToBytes(event.bytesBase64)
    const data = event.text ?? (this.binaryType === "arraybuffer" ? bytes!.buffer : new Blob([bytes!]))
    const frame = new MessageEvent("message", { data })
    this.onmessage?.(frame)
    for (const listener of this.#listeners) listener(frame)
  }

  #fail(): void {
    if (this.readyState === GATEWAY_SOCKET_CLOSED) return
    this.onerror?.(new Event("error"))
    this.#finish(1006, "Native gateway stream failed")
  }

  #finish(code: number, reason: string): void {
    if (this.readyState === GATEWAY_SOCKET_CLOSED) return
    this.readyState = GATEWAY_SOCKET_CLOSED
    this.onclose?.(closeEvent(code, reason))
  }
}

export function createNativeGatewayTransport(originInput: string, bridge: HundredfoldNativeBridge): GatewayTransport {
  const origin = gatewayOrigin(originInput)
  const httpUrl = (path: string) => new URL(gatewayPath(path), `${origin}/`).toString()
  return {
    profile: { id: `native:${origin}`, origin },
    httpUrl,
    socketUrl(path) {
      const url = new URL(httpUrl(path))
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      return url.toString()
    },
    openSocket(path) {
      return new NativeGatewaySocket(bridge, origin, gatewayPath(path))
    },
    async request(path, init = {}) {
      if (init.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError")
      const headers = new Headers(init.headers)
      const encoded = await encodeBody(init.body)
      if (encoded.contentType && !headers.has("content-type")) headers.set("content-type", encoded.contentType)
      const pending = bridge.request({
        target: { origin },
        method: init.method ?? "GET",
        path: gatewayPath(path),
        headers: [...headers].map(([name, value]) => ({ name, value })),
        bodyBase64: encoded.bodyBase64,
      })
      const payload = init.signal
        ? await Promise.race([
          pending,
          new Promise<never>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")), { once: true })),
        ])
        : await pending
      return new Response(responseBody(init.method ?? "GET", payload.status, payload.bodyBase64), {
        status: payload.status,
        headers: payload.headers.map(({ name, value }): [string, string] => [name, value]),
      })
    },
    navigate() {
      throw new Error("Native workspace switching must select a paired profile")
    },
  }
}

export function pairNativeGateway(origin: string, code: string, bridge: HundredfoldNativeBridge) {
  return bridge.pair({ target: { origin: gatewayOrigin(origin) }, code })
}
