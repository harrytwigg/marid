import type { JsonObject } from "../../shared/types.js";
import type { CallerIdentity } from "../../gateway/session-comm-guards.js";

export type TalkControlTarget = "gateway" | "browser";
export type TalkControlMutability = "read" | "write" | "effect";

export interface TalkControlParameters extends JsonObject {
  type: "object";
  properties: JsonObject;
  required: string[];
  additionalProperties: false;
}

export interface TalkControlOperation {
  name: string;
  description: string;
  parameters: TalkControlParameters;
  target: TalkControlTarget;
  intent: string;
  mutability: TalkControlMutability;
  operatorOnly: boolean;
  verification: string;
}

export interface TalkControlManifest {
  version: 1;
  operations: TalkControlOperation[];
}

export interface TalkUiEffect {
  invalidate?: string[];
  navigate?: string;
  focus?: string;
}

export interface TalkControlDispatch {
  talkSessionId: string;
  providerCallId: string;
  providerItemId?: string;
  providerEventId?: string;
  providerTranscriptItemId?: string;
  browserInstanceId?: string;
  credentialGeneration?: number;
  tool: string;
  arguments: string;
  caller: CallerIdentity;
}

export interface TalkControlExecution {
  data: Record<string, unknown>;
  uiEffect: TalkUiEffect | null;
}

export interface TalkControlVerification {
  ok: boolean;
  evidence: Record<string, unknown>;
}

export type TalkControlSuccess = {
  ok: true;
  receiptId: string;
  replayed: boolean;
  verified: true;
  operation: string;
  data: Record<string, unknown>;
  evidence: Record<string, unknown>;
  uiEffect: TalkUiEffect | null;
};

export type TalkControlFailure = {
  ok: false;
  code: string;
  error: string;
};

export type TalkControlResult = TalkControlSuccess | TalkControlFailure;

export interface TalkControlAdapterContext {
  talkSessionId: string;
  providerCallId: string;
  providerItemId?: string;
  providerEventId?: string;
  providerTranscriptItemId?: string;
  browserInstanceId?: string;
  credentialGeneration?: number;
  idempotencyKey: string;
  caller: CallerIdentity;
}

export class TalkControlRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface TalkControlRuntimeOptions {
  manifest: TalkControlManifest;
  execute: (
    operation: TalkControlOperation,
    args: Record<string, unknown>,
    context: TalkControlAdapterContext,
  ) => Promise<TalkControlExecution>;
  verify: (
    operation: TalkControlOperation,
    args: Record<string, unknown>,
    execution: TalkControlExecution,
  ) => Promise<TalkControlVerification>;
  receipts?: TalkControlReceiptStore;
  now?: () => number;
}

export interface TalkControlReceipt {
  talkSessionId: string;
  providerCallId: string;
  requestFingerprint: string;
  result: TalkControlResult;
  createdAt: number;
}

export interface TalkControlReceiptStore {
  get(talkSessionId: string, providerCallId: string): TalkControlReceipt | null;
  put(receipt: TalkControlReceipt):
    | { status: "stored" | "replayed"; receipt: TalkControlReceipt }
    | { status: "conflict"; receipt: TalkControlReceipt };
}
