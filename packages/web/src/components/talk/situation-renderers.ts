import type { ComponentType } from "react"
import type { AnswerHandler, SituationPayload } from "./situation-payload"
import { ImagesSituation, VideoSituation, imagesSpeech, videoSpeech } from "./renderers/media-set"
import { ObjectSituation, objectSpeech } from "./renderers/jinn-object"
import { OptionsSituation, optionsSpeech } from "./renderers/options"
import { ProseSituation, proseSpeech } from "./renderers/prose"
import { VoiceSetupSituation, voiceSetupSpeech } from "./renderers/voice-setup"

/**
 * One entry per payload kind: what draws it, and what a voice would say. The
 * record is keyed on the union's discriminant, so the compiler refuses a new
 * kind that forgot to register itself — and the sheet needs no branch at all.
 */

type Kind = SituationPayload["kind"]

export interface SituationRenderer {
  /** `never` is what lets each renderer declare the single payload it handles
   *  and still sit in one record: the registry key IS the discriminant, so the
   *  lookup site narrows the union once rather than every renderer widening. */
  Render: ComponentType<{ payload: never; onAnswer: AnswerHandler }>
  /** What the situation card speaks. Derived from the payload, so nothing hardcodes copy. */
  speech: (payload: never) => string
}

export const SITUATION_RENDERERS: Record<Kind, SituationRenderer> = {
  prose: { Render: ProseSituation, speech: proseSpeech },
  options: { Render: OptionsSituation, speech: optionsSpeech },
  images: { Render: ImagesSituation, speech: imagesSpeech },
  video: { Render: VideoSituation, speech: videoSpeech },
  object: { Render: ObjectSituation, speech: objectSpeech },
  "voice-setup": { Render: VoiceSetupSituation, speech: voiceSetupSpeech },
}

/** What to say for this payload, without rendering — or touching — the sheet. */
export function speech(payload: SituationPayload): string {
  return SITUATION_RENDERERS[payload.kind].speech(payload as never)
}
