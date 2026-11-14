export interface NativeGatewayTarget { origin: string }
export interface NativeHeader { name: string; value: string }
export interface NativeRequestInput {
  target: NativeGatewayTarget
  method: string
  path: string
  headers: NativeHeader[]
  bodyBase64?: string
}
export interface NativeResponsePayload {
  status: number
  headers: NativeHeader[]
  bodyBase64: string
}
export type NativeStreamInput =
  | { action: "open"; target: NativeGatewayTarget; path: string }
  | { action: "send"; streamId: string; text?: string; bytesBase64?: string }
  | { action: "close"; streamId: string }
export type NativeStreamEvent =
  | { event: "opened"; streamId: string }
  | { event: "message"; streamId: string; text?: string; bytesBase64?: string }
  | { event: "closed"; streamId: string; code?: number; reason: string }
  | { event: "failed"; streamId: string; code: string; message: string }

export interface HundredfoldNativeBridge {
  readonly runtime: "tauri"
  pair(input: { target: NativeGatewayTarget; code: string }): Promise<{ origin: string; device: { id: string; name: string } }>
  request(input: NativeRequestInput): Promise<NativeResponsePayload>
  stream(input: NativeStreamInput, onEvent: (event: NativeStreamEvent) => void): Promise<{ streamId: string }>
  forget(input: { target: NativeGatewayTarget }): Promise<{ localRemoved: boolean; remoteRevoked: boolean }>
}

declare global {
  interface Window { __HUNDREDFOLD_NATIVE__?: HundredfoldNativeBridge }
}

export function nativeBridge(): HundredfoldNativeBridge | undefined {
  return typeof window === "undefined" ? undefined : window.__HUNDREDFOLD_NATIVE__
}
