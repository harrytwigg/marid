import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { test } from "node:test"
import vm from "node:vm"

import {
  FIXTURE_CLOCK,
  TALK_SESSION_ID,
  assertDisposableHome,
  fixtureTopics,
  mergeById,
  prepareSandbox,
} from "../talk-driving-fixture.mjs"
import { TALK_DRIVING_UTTERANCES, encodePcmWav } from "../talk-driving-audio.mjs"
import { buildProbeScript, buildSpeakScript } from "../talk-driving-channel-probe.mjs"

const disposable = path.join(os.tmpdir(), ".jinn-talk-driving-fixture")

test("declares twelve durable topics with stable unique identities", () => {
  const topics = fixtureTopics({
    todoIds: {
      blocked: "PLA-1",
      blocker: "PLA-2",
      delegated: "PLA-3",
      approval: "PLA-4",
    },
    workflowId: "sandbox-approval-flow",
    workflowRunId: "run_fixture",
  })

  assert.equal(topics.length, 11)
  assert.equal(new Set(topics.map(({ id }) => id)).size, 11)
  assert.deepEqual(topics.map(({ ordinal }) => ordinal), Array.from({ length: 11 }, (_, index) => index + 1))
  assert.equal(topics[0].state, "active")
  assert.ok(topics.slice(1, 4).every(({ state }) => state === "warm"))
  assert.ok(topics.slice(4).every(({ state }) => state === "cool"))
  assert.ok(topics.every(({ talkSessionId }) => talkSessionId === TALK_SESSION_ID))
  assert.ok(topics.every(({ goal, decisions, unresolvedQuestions, retrievalAnchors }) =>
    goal.length > 0 && decisions.length > 0 && unresolvedQuestions.length > 0 && retrievalAnchors.length > 0))
})

test("uses a fixed fixture clock so cold-reload ordering is reproducible", () => {
  assert.equal(FIXTURE_CLOCK, Date.parse("2026-08-18T09:00:00.000Z"))
  assert.deepEqual(fixtureTopics({
    todoIds: { blocked: "PLA-1", blocker: "PLA-2", delegated: "PLA-3", approval: "PLA-4" },
    workflowId: "sandbox-approval-flow",
    workflowRunId: "run_fixture",
  }), fixtureTopics({
    todoIds: { blocked: "PLA-1", blocker: "PLA-2", delegated: "PLA-3", approval: "PLA-4" },
    workflowId: "sandbox-approval-flow",
    workflowRunId: "run_fixture",
  }))
})

test("refuses the installed home and protected gateway ports", () => {
  assert.throws(
    () => assertDisposableHome(path.join(os.homedir(), ".jinn"), { gateway: { port: 7999 } }),
    /production instance home/,
  )
  for (const port of [7777, 7788]) {
    assert.throws(() => assertDisposableHome(disposable, { gateway: { port } }), /protected gateway/)
  }
  assert.doesNotThrow(() => assertDisposableHome(disposable, { gateway: { port: 7799 } }))
})

test("merges owned fixture records by id without deleting unrelated records", () => {
  assert.deepEqual(
    mergeById(
      [{ id: "unrelated", value: 1 }, { id: "owned", value: 1 }],
      [{ id: "owned", value: 2 }, { id: "new", value: 3 }],
    ),
    [{ id: "unrelated", value: 1 }, { id: "owned", value: 2 }, { id: "new", value: 3 }],
  )
})

test("seeding the same stopped home twice reuses every durable identity", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-talk-driving-seed-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  port: 7799\nengines:\n  default: codex\n  claude: {}\n  codex:\n    model: gpt-5.5\nportal:\n  companyName: Sandbox Company\n  companyPrefix: SBX\n")

  const first = await prepareSandbox(home)
  const second = await prepareSandbox(home)
  assert.deepEqual(second, first)

  const requireFromJinn = createRequire(new URL("../../packages/jinn/package.json", import.meta.url))
  const Database = requireFromJinn("better-sqlite3")
  const sessions = new Database(path.join(home, "sessions", "registry.db"), { readonly: true })
  assert.equal(sessions.prepare("SELECT COUNT(*) FROM work_items").pluck().get(), 4)
  assert.equal(sessions.prepare("SELECT COUNT(*) FROM work_item_approvals WHERE state = 'pending'").pluck().get(), 1)
  assert.equal(sessions.prepare("SELECT COUNT(*) FROM talk_topics").pluck().get(), 11)
  assert.equal(sessions.prepare("SELECT COUNT(*) FROM talk_proactive_receipts").pluck().get(), 2)
  assert.equal(sessions.prepare("SELECT high_water FROM work_item_id_allocator WHERE prefix = 'PLA'").pluck().get(), 4)
  sessions.close()

  const workflows = new Database(path.join(home, "workflows", "workflows.db"), { readonly: true })
  assert.equal(workflows.prepare("SELECT COUNT(*) FROM workflow_runs").pluck().get(), 1)
  assert.equal(workflows.prepare("SELECT COUNT(*) FROM workflow_approvals WHERE status = 'pending'").pluck().get(), 1)
  workflows.close()
})

test("the driving audio catalog covers each spoken journey turn with reusable failure audio", () => {
  assert.deepEqual(TALK_DRIVING_UTTERANCES.map(({ id }) => id), [
    "grounded-read",
    "send-message",
    "create-todo",
    "assign-todo",
    "move-todo",
    "read-missing-todo",
    "transport-retry",
  ])
  assert.match(TALK_DRIVING_UTTERANCES[0].text, /what are we looking at/i)
  assert.match(TALK_DRIVING_UTTERANCES[1].synthesis, /send them a message saying ping are you still on this/i)
  assert.doesNotMatch(TALK_DRIVING_UTTERANCES[1].synthesis, /[:,?]/)
  assert.match(TALK_DRIVING_UTTERANCES.at(-2).text, /ZZZ-999/)
  assert.match(TALK_DRIVING_UTTERANCES.at(-2).synthesis, /uppercase Z, uppercase Z, uppercase Z.*dash nine nine nine/i)
  assert.match(TALK_DRIVING_UTTERANCES.at(-1).text, /fresh authoritative read/i)
  assert.match(TALK_DRIVING_UTTERANCES.at(-1).text, /do not reuse the prior result/i)
})

test("wraps synthesized PCM in a byte-exact mono WAV", () => {
  const pcm = Buffer.from([1, 2, 3, 4])
  const wav = encodePcmWav(pcm, 24_000)
  assert.equal(wav.toString("ascii", 0, 4), "RIFF")
  assert.equal(wav.toString("ascii", 8, 12), "WAVE")
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(24), 24_000)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.deepEqual(wav.subarray(44), pcm)
})

test("the microphone shim supplies a synthetic track and probes both channel directions", async () => {
  let startedSources = 0
  let silentCarrierStarts = 0
  const gains = []
  class FakeChannel {
    constructor() {
      this.readyState = "connecting"
      this.listeners = new Map()
      this.sent = []
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? []
      listeners.push(listener)
      this.listeners.set(type, listeners)
    }
    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event)
    }
    send(raw) { this.sent.push(raw) }
  }
  class FakePeer {
    createDataChannel(_label = "") {
      this.channel = new FakeChannel()
      return this.channel
    }
  }
  class FakeAudioContext {
    createMediaStreamDestination() { return { stream: { id: "fixture-mic" } } }
    createBuffer() { return { duration: 1 } }
    createGain() {
      const gain = { value: 1 }
      gains.push(gain)
      return { gain, connect() {} }
    }
    createOscillator() { return { connect() {}, start() { silentCarrierStarts += 1 } } }
    async resume() {}
    async decodeAudioData() { return { duration: 0.25 } }
    createBufferSource() {
      const source = { connect() {}, onended: null, start() { startedSources += 1; queueMicrotask(() => source.onended?.()) } }
      return source
    }
  }
  const context = {
    AudioContext: FakeAudioContext,
    Date,
    JSON,
    Promise,
    RTCPeerConnection: FakePeer,
    Uint8Array,
    atob,
    navigator: { mediaDevices: { getUserMedia: async (_constraints = {}) => ({ id: "native" }) } },
    queueMicrotask,
  }
  context.window = context
  vm.runInNewContext(fs.readFileSync(new URL("../talk-driving-mic-shim.js", import.meta.url), "utf8"), context)

  assert.equal((await context.navigator.mediaDevices.getUserMedia({ audio: true })).id, "fixture-mic")
  assert.equal((await context.navigator.mediaDevices.getUserMedia({ video: true })).id, "native")
  const peer = new context.RTCPeerConnection()
  const channel = peer.createDataChannel("oai-events")
  channel.readyState = "open"
  channel.emit("open")
  channel.emit("message", { data: JSON.stringify({ type: "response.output_audio_transcript.done", event_id: "event-1", transcript: "done" }) })
  channel.send(JSON.stringify({ type: "response.create" }))
  await context.window.__talkDriving.speakWav(Buffer.from("RIFF").toString("base64"))

  const probe = context.window.__talkDriving.probe()
  assert.equal(probe.channelState, "open")
  assert.equal(probe.spoken.length, 1)
  assert.equal(probe.incoming[0].type, "response.output_audio_transcript.done")
  assert.equal(probe.incoming[0].eventId, "event-1")
  assert.equal(probe.incoming[0].transcript, "done")
  assert.equal(probe.outgoing[0].type, "response.create")
  assert.equal(startedSources, 2)
  assert.equal(silentCarrierStarts, 1)
  assert.ok(gains[0].value > 0, "the carrier must survive WebRTC silence suppression")
  assert.ok(gains[0].value <= 0.001, "the carrier must stay inaudible and below provider VAD")
})

test("the channel probe injects WAV bytes over stdin-safe JavaScript and returns a bounded snapshot", () => {
  const wav = Buffer.from("small fixture wav")
  const speak = buildSpeakScript(wav)
  assert.match(speak, /__talkDriving\.speakWav/)
  assert.match(speak, new RegExp(wav.toString("base64")))
  assert.doesNotMatch(speak, /\/Users\//)
  assert.match(buildProbeScript(), /__talkDriving\?\.probe/)
})
