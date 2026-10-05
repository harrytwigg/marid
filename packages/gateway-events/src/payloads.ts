/**
 * The shapes that travel over the gateway → browser wire. Types only, no
 * behaviour: index.ts owns the event protocol that carries them and the
 * runtime that decodes it.
 *
 * A shape lives here rather than on either side because both sides must agree
 * on it. Declaring it twice is how a gateway and a browser drift apart.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject { [key: string]: JsonValue }

export interface MessageMediaWire {
  type: "image" | "audio" | "video" | "file"
  url: string
  name?: string
  mimeType?: string
  size?: number
}

export interface TalkProactiveUiEffect {
  type: "refresh" | "highlight"
  target: string
}

export interface TalkProactiveCuePayload {
  receiptId: string
  talkSessionId: string
  topicId: string | null
  disposition: "quiet" | "spoken"
  urgency: "routine" | "urgent"
  summary: string
  uiEffect: TalkProactiveUiEffect | null
}

export type CompanyChangedEvent =
  | { entity: "todo"; action: string; id: string; sessionId?: string; version: number; value?: JsonObject }
  /** A sprint changed: created, renamed, started, completed or deleted, or a
   *  Todo moved in or out of it. Rows embed their sprint, so a listener refetches
   *  Todo lists and details rather than patching one row. `id` is the sprint's,
   *  or the Todo's for a move. */
  | { entity: "sprint"; action: string; id: string }
  /** A project was created or edited, or a Todo moved into or out of one. Rows embed
   *  their project's name, so a listener refetches Todo lists and details. `id` is
   *  the project's, or the Todo's for a move. */
  | { entity: "project"; action: string; id: string }
