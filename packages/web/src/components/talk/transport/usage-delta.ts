/**
 * Token counts, and the two sums that keep a voice session honestly billed.
 *
 * The provider reports each response's own counts, while a `turn_done` frame
 * carries the session total after that turn — the gateway's adapter folds one
 * into the other over its socket (talk/realtime/openai.ts) and the browser does
 * the same over its data channel. `POST /api/talk/sessions/:id/turn` then prices
 * whatever it is handed as that turn alone, so the client subtracts the reading
 * before it (docs/talk-session-runtime.md). Posting a total where a delta
 * belongs bills every earlier turn again, and the over-charge compounds with the
 * conversation. Both sums live here rather than inline in the transport: one
 * place to read, and one place to get wrong.
 */

/** Structurally the gateway's `RealtimeUsage` (packages/hundredfold/src/shared/voice.ts).
 *  The web package has no import path into the gateway, so it is declared here,
 *  as `tool-spec.ts` does for `RealtimeTool`. */
export interface TalkUsage {
  inputAudioTokens: number
  outputAudioTokens: number
  inputTextTokens: number
  outputTextTokens: number
  cachedInputAudioTokens: number
  cachedInputTextTokens: number
  inputImageTokens: number
  cachedInputImageTokens: number
}

const USAGE_KEYS: readonly (keyof TalkUsage)[] = [
  "inputAudioTokens",
  "outputAudioTokens",
  "inputTextTokens",
  "outputTextTokens",
  "cachedInputAudioTokens",
  "cachedInputTextTokens",
  "inputImageTokens",
  "cachedInputImageTokens",
]

export function emptyTalkUsage(): TalkUsage {
  return {
    inputAudioTokens: 0,
    outputAudioTokens: 0,
    inputTextTokens: 0,
    outputTextTokens: 0,
    cachedInputAudioTokens: 0,
    cachedInputTextTokens: 0,
    inputImageTokens: 0,
    cachedInputImageTokens: 0,
  }
}

/** One response's counts folded into the session total that precedes it. */
export function addTalkUsage(total: TalkUsage, response: TalkUsage): TalkUsage {
  const sum = emptyTalkUsage()
  for (const key of USAGE_KEYS) sum[key] = total[key] + response[key]
  return sum
}

/**
 * What this turn added, from the session totals before it and after it.
 *
 * A count that came back lower than the previous reading clamps to zero rather
 * than posting negative: the gateway rejects any negative token count with a
 * 400, and a provider quirk in the accounting must not fail a live turn.
 */
export function usageDelta(previous: TalkUsage, total: TalkUsage): TalkUsage {
  const delta = emptyTalkUsage()
  for (const key of USAGE_KEYS) delta[key] = Math.max(0, total[key] - previous[key])
  return delta
}
