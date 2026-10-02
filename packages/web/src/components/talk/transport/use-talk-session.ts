/**
 * The talk session's lifecycle, as React sees it.
 *
 * Mount may inspect a stored session with one GET, but opening or resuming
 * mints a paid provider credential and asks for the microphone, so those happen
 * on an operator gesture and nothing else — not mount, navigation, or visibility.
 *
 * The session itself lives in a ref rather than in state: it is an open
 * connection with a heartbeat behind it, and re-rendering must not be able to
 * open a second one. What renders is only what the orb shows.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import type { OrbEnergy, OrbState } from "../orb-motion"
import {
  clearResumableTalkSession,
  readResumableTalkSession,
  rememberResumableTalkSession,
  setTalkSessionId,
} from "../talk-session-store"
import { detach, useAttach, type Attachment } from "./attachment"
import { fetchTalkCapability } from "@/lib/talk-capability"
import { useParkWhileHidden } from "./park-while-hidden"
import {
  VoiceUnconfiguredError,
  closeTalkSession,
  openTalkSession,
  parkTalkSession,
  startTalkHeartbeat,
  type OpenTalkSession,
} from "./session-client"
import { reason, type LiveSession, type SessionControls, type TalkSetupNeeded } from "./session-controls"
import { resumeHeldSession, startOverTalkRuntime, useDiscoverResumable } from "./session-recovery"
import { connectRealtime, type ConnectRealtime } from "./webrtc-connection"

export type { TalkSetupNeeded }

export interface TalkSessionHandle {
  /** Whether the realtime provider and microphone are currently attached. */
  active: boolean
  /** A durable conversation is ready, but no credential or microphone is live. */
  parked: boolean
  state: OrbState
  /** Live 0..1 loudness of each side, mutated in place by the connection. */
  energyRef: RefObject<OrbEnergy>
  /** The last failure, in the words of whoever refused. Null once it is past. */
  error: string | null
  /** Set instead of `error` when the only thing wrong is that voice was never
   *  configured — a gap with something to do about it, not a message. */
  setup: TalkSetupNeeded | null
  toggle: () => void
  /** End only the old realtime runtime, then begin a separate Talk chat. */
  startOver: () => void
  /** Speak one already-authorized proactive receipt through the live provider. */
  cue: (
    summary: string,
    receiptId: string,
    settled: (outcome: "completed" | "interrupted") => void,
  ) => boolean
}

/** Tear the realtime session down locally, whether it is parked or closed. */
function useForget(
  liveRef: RefObject<LiveSession | null>,
  generationRef: RefObject<number>,
  setActive: (active: boolean) => void,
  setParked: (parked: boolean) => void,
  setState: (state: OrbState) => void,
) {
  return useCallback(
    (live: LiveSession) => {
      generationRef.current += 1
      live.stopHeartbeat()
      if (live.attachment) detach(live.attachment)
      liveRef.current = null
      setTalkSessionId(null)
      setActive(false)
      setParked(false)
      setState("idle")
    },
    [liveRef, generationRef, setActive, setParked, setState],
  )
}

/**
 * Open a session, then connect to the provider with the credential it minted.
 *
 * The two halves fail differently and both have to leave nothing behind: a
 * refused open never names a session, and a session that opened but never
 * connected is closed here rather than left for the reaper ninety seconds later.
 * A page that left while this was in flight keeps the normal chat and parks the
 * Talk runtime, so a reload can offer the same conversation again.
 *
 * It starts by asking whether voice is set up at all, because the alternative is
 * charging the operator for the answer. The gateway can still refuse the mint
 * for the same reason — the config can change between the two calls — and that
 * refusal is routed to the same place rather than shown as a message.
 */
function installOpenedSession(controls: SessionControls, session: OpenTalkSession, attachment: Attachment): void {
  controls.liveRef.current = {
    id: session.id,
    attachment,
    brief: session.brief,
    topicMemory: session.topicMemory,
    manifest: session.manifest,
    browserInstanceId: session.browserInstanceId,
    parkedAtGateway: false,
    stopHeartbeat: startTalkHeartbeat(session.id),
  }
  controls.setActive(true)
  controls.setParked(false)
  controls.setState("listening")
}

function reportOpenFailure(controls: SessionControls, failure: unknown, providers: string[], opened: string | null): void {
  if (failure instanceof VoiceUnconfiguredError) controls.setSetup({ providers })
  else controls.setError(reason(failure))
  controls.setState("error")
  controls.setActive(false)
  if (opened) {
    clearResumableTalkSession(opened)
    void closeTalkSession(opened).catch(() => {})
  }
  setTalkSessionId(null)
}

async function openSession(controls: SessionControls): Promise<void> {
  if (controls.liveRef.current || controls.openingRef.current) return
  controls.openingRef.current = true
  controls.setError(null)
  controls.setSetup(null)
  controls.setState("thinking")

  const generation = controls.generationRef.current
  let opened: string | null = null
  let providers: string[] = []
  try {
    const capability = await fetchTalkCapability()
    providers = capability.providers
    if (!capability.configured) {
      controls.setSetup({ providers })
      controls.setState("error")
      return
    }
    const session = await openTalkSession()
    opened = session.id
    rememberResumableTalkSession(opened)
    setTalkSessionId(opened)
    const identity = { browserInstanceId: session.browserInstanceId, credentialGeneration: session.credentialGeneration,
      topicMemory: session.topicMemory, vadType: session.vadType }
    const attachment = await controls.attach(opened, session.token, session.brief, session.manifest, identity)
    if (generation !== controls.generationRef.current) {
      detach(attachment)
      setTalkSessionId(null)
      void parkTalkSession(opened).catch(() => {})
      return
    }
    installOpenedSession(controls, session, attachment)
  } catch (failure) {
    reportOpenFailure(controls, failure, providers, opened)
  } finally {
    controls.openingRef.current = false
  }
}

async function closeSession(controls: SessionControls): Promise<void> {
  const live = controls.liveRef.current
  if (!live) return
  clearResumableTalkSession(live.id)
  controls.forget(live)
  try {
    await closeTalkSession(live.id)
  } catch (failure) {
    controls.setError(reason(failure))
  }
}

async function retrySession(controls: SessionControls): Promise<void> {
  await closeSession(controls)
  await openSession(controls)
}

/**
 * A closing page hands the realtime runtime back but retains its normal chat.
 * The candidate is scoped to this browser tab and can only resume on a gesture.
 */
function useCloseOnLeaving(
  liveRef: RefObject<LiveSession | null>,
  generationRef: RefObject<number>,
  forget: (live: LiveSession) => void,
): void {
  // StrictMode tears every effect down and rebuilds it once on mount, so the
  // cleanup below also runs on a mount that is not a leave. This flag is set by
  // the cleanup and cleared by the rebuild; the deferred leave reads a cleared
  // flag and does nothing. A real unmount has no rebuild after it, so the flag
  // stays set and the session is parked.
  const leavingRef = useRef(false)
  useEffect(() => {
    leavingRef.current = false
    const onLeaving = () => {
      // Bumped even with nothing live: an open still in flight has a session
      // named on the gateway, and `openSession` parks it once it sees this.
      generationRef.current += 1
      const live = liveRef.current
      if (!live) return
      rememberResumableTalkSession(live.id)
      forget(live)
      void parkTalkSession(live.id).catch(() => {})
    }
    window.addEventListener("pagehide", onLeaving)
    window.addEventListener("beforeunload", onLeaving)
    return () => {
      window.removeEventListener("pagehide", onLeaving)
      window.removeEventListener("beforeunload", onLeaving)
      // Unmounting the surface is a page leaving by a shorter route. Defer it a
      // microtask so StrictMode's teardown-and-rebuild — which happens
      // synchronously, before any microtask runs — cancels it; a real unmount
      // is not followed by a rebuild, so the leave still runs.
      leavingRef.current = true
      queueMicrotask(() => {
        if (leavingRef.current) onLeaving()
      })
    }
  }, [liveRef, generationRef, forget])
}

export function useTalkSession(connect: ConnectRealtime = connectRealtime): TalkSessionHandle {
  const [active, setActive] = useState(false)
  const [parked, setParked] = useState(false)
  const [state, setState] = useState<OrbState>("idle")
  const [error, setError] = useState<string | null>(null)
  const [setup, setSetup] = useState<TalkSetupNeeded | null>(null)
  const energyRef = useRef<OrbEnergy>({ input: 0, output: 0 })
  const liveRef = useRef<LiveSession | null>(null)
  const openingRef = useRef(false)
  const generationRef = useRef(0)
  const attach = useAttach(connect, energyRef, setState, setError)
  const forget = useForget(liveRef, generationRef, setActive, setParked, setState)

  const controls = useMemo<SessionControls>(
    () => ({ liveRef, openingRef, generationRef, attach, forget, setActive, setParked, setState, setError, setSetup }),
    [attach, forget],
  )

  useDiscoverResumable(controls)

  const toggle = useCallback(() => {
    if (liveRef.current?.attachment && error) void retrySession(controls)
    else if (liveRef.current?.attachment) void closeSession(controls)
    else if (liveRef.current || readResumableTalkSession()) {
      void resumeHeldSession(controls, () => openSession(controls))
    }
    else void openSession(controls)
  }, [controls, error])

  const startOver = useCallback(() => {
    void startOverTalkRuntime(controls, () => openSession(controls))
  }, [controls])

  const cue = useCallback((summary: string, receiptId: string, settled: (outcome: "completed" | "interrupted") => void) => {
    return liveRef.current?.attachment?.driver.cue(summary, receiptId, settled) ?? false
  }, [])

  useParkWhileHidden(controls)
  useCloseOnLeaving(liveRef, generationRef, forget)

  return { active, parked, state, energyRef, error, setup, toggle, startOver, cue }
}
