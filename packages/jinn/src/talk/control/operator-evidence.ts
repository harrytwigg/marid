import { TalkControlRefusal, type TalkControlAdapterContext } from "./types.js";

/** A control call proven to belong to the operator's own live utterance. */
export type BoundOperatorCall = TalkControlAdapterContext & {
  browserInstanceId: string;
  credentialGeneration: number;
  providerTranscriptItemId: string;
};

/**
 * The evidence a write that reaches past this browser has to carry.
 *
 * An authenticated operator token says who the request belongs to; it does not
 * say that the operator asked for this, now, on this session. These three
 * anchors do: the browser instance and credential generation the gateway minted
 * for the live orb, and the provider item id of the operator's own final
 * transcript. A model that decided on its own to send cannot produce them.
 *
 * Sending into a named session is a write nobody can take back once it lands —
 * whoever is on that session may act on the message immediately — so it is
 * gated on this evidence rather than on a weaker rule of its own.
 */
export function requireBoundOperatorEvidence(
  call: TalkControlAdapterContext,
  code: string,
  what: string,
): asserts call is BoundOperatorCall {
  if (!call.browserInstanceId || !call.credentialGeneration || !call.providerTranscriptItemId) {
    throw new TalkControlRefusal(code, `${what} requires bound final transcript evidence.`);
  }
}
