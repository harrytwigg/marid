import { useEffect, useRef } from "react"
import { useGateway } from "@/hooks/use-gateway"
import type { GatewayEvent, TalkProactiveCuePayload } from "@hundredfold/gateway-events"
import { applyTalkUiEffect, type TalkUiEffect } from "./ui-effects"
import { acknowledgeTalkProactiveCue, getTalkSession } from "./session-client"

interface ProactiveCueReceiverOptions {
  sessionId: () => string | null
  speak: (
    summary: string,
    receiptId: string,
    settled: (outcome: "completed" | "interrupted") => void,
  ) => boolean
  apply?: (effect: TalkUiEffect | null) => Promise<void>
  acknowledge?: typeof acknowledgeTalkProactiveCue
  seen?: Set<string>
}

function browserEffect(cue: TalkProactiveCuePayload): TalkUiEffect | null {
  if (!cue.uiEffect) return null
  return cue.uiEffect.type === "refresh"
    ? { invalidate: [cue.uiEffect.target] }
    : { focus: cue.uiEffect.target }
}

/**
 * One typed gateway frame into one bounded browser outcome. Receipt identity is
 * claimed before asynchronous work starts, so duplicate WebSocket delivery can
 * neither repeat a highlight/refresh nor ask Aurora to speak twice.
 */
export function createProactiveCueReceiver(options: ProactiveCueReceiverOptions) {
  const seen = options.seen ?? new Set<string>()
  const apply = options.apply ?? applyTalkUiEffect
  const acknowledge = options.acknowledge ?? acknowledgeTalkProactiveCue
  return async (frame: GatewayEvent): Promise<void> => {
    if (frame.event !== "talk:proactive-cue") return
    const cue = frame.payload
    if (cue.talkSessionId !== options.sessionId() || seen.has(cue.receiptId)) return
    if (cue.disposition === "spoken" && cue.urgency === "urgent") {
      const accepted = options.speak(cue.summary, cue.receiptId, (outcome) => {
        void acknowledge(cue.talkSessionId, cue.receiptId, outcome).catch(() => {
          seen.delete(cue.receiptId)
        })
      })
      if (!accepted) return
      seen.add(cue.receiptId)
      return
    }
    seen.add(cue.receiptId)
    try {
      const effect = browserEffect(cue)
      if (effect) await apply(effect)
      await acknowledge(cue.talkSessionId, cue.receiptId, "completed")
    } catch (error) {
      seen.delete(cue.receiptId)
      throw error
    }
  }
}

/** Follow proactive receipts for the current Talk runtime without adding a UI
 * surface. Quiet receipts only touch the existing page; urgent spoken receipts
 * enter the already-live provider connection through Aurora. */
export function useTalkProactiveCues(
  sessionId: string | null,
  active: boolean,
  speak: ProactiveCueReceiverOptions["speak"],
): void {
  const { subscribe } = useGateway()
  const sessionRef = useRef(sessionId)
  const speakRef = useRef(speak)
  const seenRef = useRef(new Set<string>())
  sessionRef.current = sessionId
  speakRef.current = speak

  useEffect(() => {
    const receive = createProactiveCueReceiver({
      sessionId: () => sessionRef.current,
      speak: (summary, receiptId, settled) => speakRef.current(summary, receiptId, settled),
      seen: seenRef.current,
    })
    const unsubscribe = subscribe((frame) => { void receive(frame) })
    if (active && sessionId) {
      void getTalkSession(sessionId).then((status) => {
        for (const cue of status.proactiveCues) void receive({ event: "talk:proactive-cue", payload: cue })
      }).catch(() => {})
    }
    return unsubscribe
  }, [active, sessionId, subscribe])
}
