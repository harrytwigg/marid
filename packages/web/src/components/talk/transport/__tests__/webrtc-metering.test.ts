/**
 * The microphone half of the orb's pulse.
 *
 * Before the operator's track was metered, only the assistant's track was metered, so the orb could not
 * move while the operator talked to it. jsdom implements none of the audio
 * stack, so the whole peer is stubbed here and what is asserted is the wiring:
 * which stream lands in which channel, and that neither meter outlives `close`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OrbEnergy } from "../../orb-motion"
import { connectRealtime } from "../webrtc-connection"

/** RMS is scaled by 4 and clamped, so a byte offset of 16 reads as 0.5. */
const HALF = 128 + 16
const QUARTER = 128 + 8

interface FakeStream {
  id: string
  getTracks: () => Array<{ stop: () => void }>
}

function stream(id: string): FakeStream {
  return { id, getTracks: () => [{ stop: vi.fn() }] }
}

/** Each stream is metered by its own context; the byte level it reports is what
 *  distinguishes the microphone from the assistant in the assertions. */
const LEVELS = new Map<string, number>()
const closedContexts: string[] = []

function installAudio() {
  class FakeAudioContext {
    private sourceId = "?"
    createAnalyser() {
      const self = this
      return {
        fftSize: 256,
        frequencyBinCount: 8,
        getByteTimeDomainData(target: Uint8Array) {
          target.fill(LEVELS.get(self.sourceId) ?? 128)
        },
      }
    }
    createMediaStreamSource(source: FakeStream) {
      this.sourceId = source.id
      return { connect: () => {} }
    }
    close() {
      closedContexts.push(this.sourceId)
      return Promise.resolve()
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext)
}

let tracks: ((event: { streams: FakeStream[] }) => void) | null = null

function installPeer() {
  class FakePeer {
    ontrack: ((event: { streams: FakeStream[] }) => void) | null = null
    onconnectionstatechange: (() => void) | null = null
    connectionState = "connected"
    addTrack() {}
    createDataChannel() {
      return { readyState: "open", send: vi.fn(), onopen: null, onmessage: null }
    }
    createOffer() { return Promise.resolve({ type: "offer", sdp: "v=0" }) }
    setLocalDescription() { return Promise.resolve() }
    setRemoteDescription() { return Promise.resolve() }
    close() {}
    constructor() {
      queueMicrotask(() => { tracks = this.ontrack })
    }
  }
  vi.stubGlobal("RTCPeerConnection", FakePeer)
}

/** rAF is driven by hand so a "frame" is exactly one metering read. */
let frames: FrameRequestCallback[] = []
const cancelled: number[] = []

beforeEach(() => {
  LEVELS.clear()
  closedContexts.length = 0
  frames = []
  cancelled.length = 0
  tracks = null
  installAudio()
  installPeer()
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => cancelled.push(handle))
  vi.stubGlobal("fetch", vi.fn(async () => new Response("v=0 answer", { status: 200 })))
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => stream("microphone")) },
  })
  // jsdom's `play` returns undefined rather than a promise.
  HTMLMediaElement.prototype.play = vi.fn(async () => {})
})

afterEach(() => vi.unstubAllGlobals())

/** Run every frame queued so far, once. */
function tick() {
  const queued = frames.splice(0)
  for (const frame of queued) frame(16)
}

async function connect(energy: { current: OrbEnergy }) {
  const connection = await connectRealtime({
    token: "ephemeral",
    energy,
    onOpen: () => {},
    onFrame: () => {},
    onClose: () => {},
  })
  await Promise.resolve()
  return connection
}

describe("what the orb is allowed to hear", () => {
  it("meters the microphone into input and the assistant into output", async () => {
    const energy = { current: { input: 0, output: 0 } }
    LEVELS.set("microphone", HALF)
    LEVELS.set("assistant", QUARTER)

    const connection = await connect(energy)
    tracks?.({ streams: [stream("assistant")] })
    tick()

    expect(energy.current.input).toBeCloseTo(0.5, 1)
    expect(energy.current.output).toBeCloseTo(0.25, 1)
    connection.close()
  })

  it("keeps the two channels independent, which is what a barge-in needs", async () => {
    const energy = { current: { input: 0, output: 0 } }
    LEVELS.set("microphone", HALF)
    LEVELS.set("assistant", 128)

    const connection = await connect(energy)
    tracks?.({ streams: [stream("assistant")] })
    tick()

    expect(energy.current.input).toBeGreaterThan(0)
    expect(energy.current.output).toBe(0)
    connection.close()
  })

  it("cools both meters on close, so nothing keeps reading a dead session", async () => {
    const energy = { current: { input: 0, output: 0 } }
    LEVELS.set("microphone", HALF)
    LEVELS.set("assistant", HALF)

    const connection = await connect(energy)
    tracks?.({ streams: [stream("assistant")] })
    tick()
    expect(energy.current).toEqual({ input: expect.any(Number), output: expect.any(Number) })

    connection.close()

    expect(energy.current).toEqual({ input: 0, output: 0 })
    expect(closedContexts.sort()).toEqual(["assistant", "microphone"])
    expect(cancelled).toHaveLength(2)
  })
})
