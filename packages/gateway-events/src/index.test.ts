import { describe, expect, it } from "vitest"

import { decodeGatewayEvent } from "./index.js"

describe("decodeGatewayEvent", () => {
  it("accepts bounded proactive Talk cue events", () => {
    expect(decodeGatewayEvent({
      event: "talk:proactive-cue",
      payload: {
        receiptId: "receipt-1",
        talkSessionId: "talk-1",
        topicId: "topic-1",
        disposition: "spoken",
        urgency: "urgent",
        summary: "A related chat failed.",
        uiEffect: { type: "refresh", target: "chat:chat-1" },
      },
    })).not.toBeNull()
    expect(decodeGatewayEvent({
      event: "talk:proactive-cue",
      payload: { receiptId: "receipt-1", talkSessionId: "talk-1", topicId: null, disposition: "loud" },
    })).toBeNull()
  })

  it("accepts the status a session reports while its background sub-agents work", () => {
    const payload = {
      sessionId: "s-1",
      transportState: "running",
      status: "running",
      backgroundActivity: {
        activeStreams: 0,
        activeAgents: 0,
        backgroundAgents: 2,
        backgroundRerun: false,
        lastActivityAt: "2026-10-01T20:00:00.000Z",
      },
    }
    expect(decodeGatewayEvent({ event: "session:background", payload })).toEqual({ event: "session:background", payload })
    expect(decodeGatewayEvent({
      event: "session:background",
      payload: { ...payload, backgroundActivity: { ...payload.backgroundActivity, backgroundRerun: "yes" } },
    })).toBeNull()
  })

  it("accepts experiment lifecycle events", () => {
    for (const action of ["created", "updated", "reading-recorded", "concluded"]) {
      expect(decodeGatewayEvent({
        event: "experiments:changed",
        payload: { id: "experiment-1", action },
      })).toEqual({
        event: "experiments:changed",
        payload: { id: "experiment-1", action },
      })
    }
  })

  it("accepts video media in session attachment events", () => {
    expect(decodeGatewayEvent({
      event: "session:attachment",
      payload: {
        sessionId: "session-1",
        id: "message-1",
        content: "Demo",
        media: [{ type: "video", url: "/api/files/video-1", mimeType: "video/mp4" }],
        timestamp: 1,
      },
    })).not.toBeNull()
  })

  it("rejects non-JSON values nested in company Todo snapshots", () => {
    expect(decodeGatewayEvent({
      event: "company:changed",
      payload: {
        entity: "todo",
        action: "updated",
        id: "todo-1",
        version: 2,
        value: { score: Number.POSITIVE_INFINITY },
      },
    })).toBeNull()
  })
})
