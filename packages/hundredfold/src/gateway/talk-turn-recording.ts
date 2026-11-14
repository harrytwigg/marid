import { initDb } from "../shared/db.js";
import type { RealtimeUsage } from "../shared/voice.js";
import { getSessionSpend, recordTurnAccounting, updateSession } from "../sessions/registry.js";
import { insertTalkMessage } from "../sessions/talk-message-store.js";
import { contextTokens, estimateTokens, handoffSuggested } from "../talk/session/context.js";
import type { TalkSessionRegistry, TalkTurnResult } from "../talk/session/registry.js";
import type { TalkSession, TalkTurnRecord, VisualCaptureReceipt } from "../talk/session/types.js";

interface PersistTurnInput {
  session: TalkSession;
  registry: TalkSessionRegistry;
  usage: RealtimeUsage;
  transcript: string;
  visualReceipts: readonly VisualCaptureReceipt[];
  providerResponseId?: string;
  providerItemId?: string;
  costUsd: number;
}

export interface PersistedTalkTurn extends TalkTurnResult {
  replayed: boolean;
  messageId: string;
  spendUsd: number;
}

function replayResult(session: TalkSession, transcript: string): TalkTurnResult {
  const record: TalkTurnRecord = { at: Date.now(), text: transcript, estimatedTokens: estimateTokens(transcript) };
  return {
    contextTokens: contextTokens(session.turns),
    truncatedTurns: session.truncatedTurns,
    handoffSuggested: handoffSuggested(record),
  };
}

export function persistTalkTurn(input: PersistTurnInput): PersistedTalkTurn {
  return initDb().transaction(() => {
    const identity = input.providerResponseId ? `response:${input.session.credentialGeneration}:${input.providerResponseId}` : undefined;
    const message = insertTalkMessage({
      sessionId: input.session.sessionId,
      role: "assistant",
      content: input.transcript,
      identity,
      meta: { talk: {
        kind: "turn",
        talkSessionId: input.session.id,
        credentialGeneration: input.session.credentialGeneration,
        ...(input.providerResponseId ? { providerResponseId: input.providerResponseId } : {}),
        ...(input.providerItemId ? { providerItemId: input.providerItemId } : {}),
        usage: { ...input.usage },
        screenshotCount: input.visualReceipts.length,
      } },
    });
    const turn = message.created
      ? input.registry.appendTurn(input.session.id, input.transcript, undefined, input.visualReceipts)
      : replayResult(input.registry.get(input.session.id) ?? input.session, input.transcript);
    if (message.created) {
      recordTurnAccounting(input.session.sessionId, { cost: input.costUsd, numTurns: 1 });
      updateSession(input.session.sessionId, {
        lastActivity: new Date().toISOString(),
        lastContextTokens: turn.contextTokens,
      });
    }
    return {
      ...turn,
      replayed: !message.created,
      messageId: message.id,
      spendUsd: getSessionSpend([input.session.sessionId]),
    };
  })();
}
