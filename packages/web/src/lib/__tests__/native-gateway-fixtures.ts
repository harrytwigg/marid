import { vi } from "vitest"
import type {
  HundredfoldNativeBridge,
  NativeRequestInput,
  NativeResponsePayload,
  NativeStreamEvent,
  NativeStreamInput,
} from "@/platform/native-bridge"

export class MemoryStorage implements Storage {
  #values = new Map<string, string>()
  get length() { return this.#values.size }
  clear() { this.#values.clear() }
  getItem(key: string) { return this.#values.get(key) ?? null }
  key(index: number) { return [...this.#values.keys()][index] ?? null }
  removeItem(key: string) { this.#values.delete(key) }
  setItem(key: string, value: string) { this.#values.set(key, value) }
}

export function response(value: unknown, status = 200): NativeResponsePayload {
  return {
    status,
    headers: [{ name: "content-type", value: "application/json" }],
    bodyBase64: btoa(JSON.stringify(value)),
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

export function bridgeFixture() {
  const streams = new Map<string, (event: NativeStreamEvent) => void>()
  let streamSequence = 0
  const requests = vi.fn(async (input: NativeRequestInput) => response({
    authRequired: true,
    authenticated: true,
    canBootstrapLocal: false,
    networkExposed: false,
    instance: input.target.origin.endsWith("7779") ? "alpha" : "beta",
  }))
  const bridge: HundredfoldNativeBridge = {
    runtime: "tauri",
    pair: vi.fn(async ({ target }) => ({
      origin: new URL(target.origin).origin,
      device: { id: `device:${new URL(target.origin).port}`, name: "Hundredfold shell" },
    })),
    request: requests,
    stream: vi.fn(async (input: NativeStreamInput, onEvent) => {
      if (input.action !== "open") return { streamId: input.streamId }
      const streamId = `stream-${++streamSequence}`
      streams.set(streamId, onEvent)
      onEvent({ event: "opened", streamId })
      return { streamId }
    }),
    forget: vi.fn(async () => ({ localRemoved: true, remoteRevoked: true })),
  }
  return { bridge, requests, streams }
}
