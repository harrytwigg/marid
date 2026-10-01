/**
 * What a situation can put in front of the operator. One discriminated union,
 * one renderer per kind (see `situation-renderers.ts`), so another kind is a new
 * member here plus a new entry there — and nothing in the sheet changes.
 *
 * Every card answers by its own id: there is no confirm step anywhere.
 */

export interface SituationOption {
  id: string
  label: string
  /** One supporting line. Longer than that belongs in the situation's hint. */
  detail?: string
}

export interface SituationImage {
  id: string
  src: string
  alt: string
  caption?: string
}

export interface SituationClip {
  id: string
  src: string
  poster?: string
  label: string
}

/** A live thing in this instance, resolved through the normal query layer. */
export type JinnObjectRef =
  | { type: "todo"; id: string }
  | { type: "session"; id: string }

export type SituationPayload =
  | { kind: "prose"; text: string }
  | { kind: "options"; options: SituationOption[] }
  | { kind: "images"; images: SituationImage[] }
  | { kind: "video"; clips: SituationClip[] }
  | { kind: "object"; object: JinnObjectRef }
  /** Voice has no provider that would work yet. `providers` is what this gateway
   *  implements, so the card can only offer a choice that would actually run. */
  | { kind: "voice-setup"; providers: string[] }

/** The envelope the sheet draws. Text lives here and in the undo strip, and
 *  nowhere else in the surface. */
export interface Situation {
  id: string
  title: string
  /** One subtitle line under the title. */
  hint?: string
  payload: SituationPayload
  /** One closing line under the payload. */
  footer?: string
}

/** Called with the id of the card the operator picked. */
export type AnswerHandler = (choiceId: string) => void
