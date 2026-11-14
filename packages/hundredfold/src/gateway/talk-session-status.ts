import { getSessionSpend } from "../sessions/registry.js";
import { initDb } from "../shared/db.js";
import type { TalkControlManifest } from "../talk/control/types.js";
import { TALK_CONTEXT_BUDGET_TOKENS, contextTokens, estimateTokens } from "../talk/session/context.js";
import { isPricingKnown } from "../talk/session/pricing.js";
import { estimateToolTokens, toolsByName } from "../talk/session/tools.js";
import type { TalkSession } from "../talk/session/types.js";
import { formatTalkTopicMemory } from "../talk/topics/rehydrate.js";
import { TalkTopicRepository } from "../talk/topics/repository.js";
import { measureTopicContext } from "../talk/topics/telemetry.js";
import { TalkProactiveRepository } from "../talk/proactive/repository.js";
import { TalkProactiveService } from "../talk/proactive/service.js";

/** The session as the client sees it. Credentials only leave the minting call. */
export function talkSessionStatus(session: TalkSession, manifest: TalkControlManifest) {
  const topicRepository = new TalkTopicRepository(initDb());
  const topics = topicRepository.list(session.id);
  const navigation = topicRepository.navigation(session.id);
  return {
    id: session.id,
    browserInstanceId: session.browserInstanceId,
    credentialGeneration: session.credentialGeneration,
    sessionId: session.sessionId,
    state: session.state,
    model: session.model,
    openedAt: session.openedAt,
    lastSeenAt: session.lastSeenAt,
    turns: session.turns,
    truncatedTurns: session.truncatedTurns,
    actions: session.actions,
    interruptions: session.interruptions ?? [],
    brief: session.brief,
    // The brief rides replaced instructions, outside the rolling turn budget.
    briefChars: session.brief.length,
    briefTokens: estimateTokens(session.brief),
    contextTokens: contextTokens(session.turns),
    contextBudgetTokens: TALK_CONTEXT_BUDGET_TOKENS,
    exposedTools: session.exposedTools,
    toolTokens: estimateToolTokens(toolsByName(session.exposedTools)),
    spendUsd: getSessionSpend([session.sessionId]),
    pricingKnown: isPricingKnown(session.model),
    topicMemory: formatTalkTopicMemory(topics, navigation.currentTopicId),
    topicTelemetry: measureTopicContext(topics),
    proactiveCues: new TalkProactiveService(new TalkProactiveRepository(initDb())).pendingCues(session.id),
    manifest,
  };
}
