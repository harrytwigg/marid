import type { TalkProactiveCuePayload, TalkProactiveUiEffect } from "../../shared/gateway-events.js";

export type ProactiveCuePayload = TalkProactiveCuePayload;
export type ProactiveUiEffect = TalkProactiveUiEffect;
export type ProactiveDisposition = "ignore" | "quiet" | "spoken";
export type ProactiveUrgency = "routine" | "urgent";
export type ProactiveReceiptStatus = "ignored" | "delivering" | "retryable" | "delivered" | "failed";
export type ProactiveInterruptionState = "none" | "requested" | "completed" | "interrupted";

export interface ProactiveSignal {
  eventId: string;
  dedupeKey: string;
  talkSessionId: string;
  topicId: string | null;
  source: "todo" | "workflow" | "chat" | "cron" | "plugin" | "employee";
  subjectId: string;
  severity: "info" | "success" | "warning" | "critical";
  blocking: boolean;
  requiresOperator: boolean;
  summary: string;
  uiEffect: ProactiveUiEffect | null;
  occurredAt: number;
}

export interface ProactivePolicyContext {
  activeTopicId: string | null;
  knownTopicIds: readonly string[];
  lastSpokenAt: number | null;
  now: number;
}

export interface ProactiveDecision {
  disposition: ProactiveDisposition;
  urgency: ProactiveUrgency;
  reason: string;
}

export interface ProactiveReceipt {
  id: string;
  talkSessionId: string;
  eventId: string;
  dedupeKey: string;
  topicId: string | null;
  urgency: ProactiveUrgency;
  disposition: ProactiveDisposition;
  reason: string;
  summary: string;
  uiEffect: ProactiveUiEffect | null;
  status: ProactiveReceiptStatus;
  attempts: number;
  interruptionState: ProactiveInterruptionState;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  acknowledgedAt: number | null;
  nextAttemptAt: number | null;
  leaseUntil: number | null;
  lastError: string | null;
}

export interface ProactiveHandleContext {
  activeTopicId: string | null;
  knownTopicIds: readonly string[];
  lastSpokenAt?: number | null;
}

export interface ProactiveHandleResult {
  status: "delivered" | "ignored" | "retryable" | "failed" | "replayed" | "deferred" | "in-flight";
  receipt: ProactiveReceipt;
}
