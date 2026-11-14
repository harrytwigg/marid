import { decideProactiveDisposition } from "./policy.js";
import { TalkProactiveRepository } from "./repository.js";
import type {
  ProactiveCuePayload,
  ProactiveHandleContext,
  ProactiveHandleResult,
  ProactiveInterruptionState,
  ProactiveReceipt,
  ProactiveSignal,
} from "./types.js";

const DELIVERY_LEASE_MS = 10_000;
const RETRY_DELAY_MS = 1_000;
const MAX_DELIVERY_ATTEMPTS = 3;

function cue(receipt: ProactiveReceipt): ProactiveCuePayload {
  if (receipt.disposition === "ignore") throw new Error("An ignored proactive receipt has no cue payload.");
  return {
    receiptId: receipt.id,
    talkSessionId: receipt.talkSessionId,
    topicId: receipt.topicId,
    disposition: receipt.disposition,
    urgency: receipt.urgency,
    summary: receipt.summary,
    uiEffect: receipt.uiEffect,
  };
}

export class TalkProactiveService {
  constructor(private readonly repository: TalkProactiveRepository, private readonly now: () => number = Date.now) {}

  handle(signal: ProactiveSignal, context: ProactiveHandleContext, deliver: (payload: ProactiveCuePayload) => void): ProactiveHandleResult {
    const now = this.now();
    const lastSpokenAt = context.lastSpokenAt === undefined
      ? this.repository.latestSpokenAt(signal.talkSessionId)
      : context.lastSpokenAt;
    const decision = decideProactiveDisposition(signal, { ...context, lastSpokenAt, now });
    const claimed = this.repository.claim(signal, decision, now, DELIVERY_LEASE_MS, MAX_DELIVERY_ATTEMPTS);
    if (claimed.kind === "ignored") return { status: "ignored", receipt: claimed.receipt };
    if (claimed.kind === "replayed") return { status: "replayed", receipt: claimed.receipt };
    if (claimed.kind === "deferred") return { status: "deferred", receipt: claimed.receipt };
    if (claimed.kind === "in-flight") return { status: "in-flight", receipt: claimed.receipt };
    try {
      deliver(cue(claimed.receipt));
      return { status: "delivered", receipt: this.repository.markDelivered(claimed.receipt.id, now) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const receipt = this.repository.markFailure(claimed.receipt.id, message, now, MAX_DELIVERY_ATTEMPTS, RETRY_DELAY_MS);
      return { status: receipt.status === "failed" ? "failed" : "retryable", receipt };
    }
  }

  recordInterruption(id: string, state: Extract<ProactiveInterruptionState, "completed" | "interrupted">): ProactiveReceipt {
    return this.repository.recordInterruption(id, state, this.now());
  }

  pendingCues(talkSessionId: string): ProactiveCuePayload[] {
    return this.repository.pending(talkSessionId).map(cue);
  }

  acknowledge(
    talkSessionId: string,
    id: string,
    outcome: Extract<ProactiveInterruptionState, "completed" | "interrupted">,
  ): ProactiveReceipt {
    return this.repository.acknowledge(talkSessionId, id, outcome, this.now());
  }
}
