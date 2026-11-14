import { createHash, randomUUID } from "node:crypto";
import { operationByName } from "./manifest.js";
import { TalkControlRefusal } from "./types.js";
import type {
  TalkControlDispatch,
  TalkControlFailure,
  TalkControlResult,
  TalkControlRuntimeOptions,
  TalkControlSuccess,
} from "./types.js";

interface HeldCall {
  fingerprint: string;
  promise: Promise<TalkControlResult>;
}

function failure(code: string, error: string): TalkControlFailure {
  return { ok: false, code, error };
}

/** Long enough for an adapter sentence naming an id, short enough that no
 *  message the model reads back can run away. */
const REASON_CHARS = 300;

function clipReason(reason: string): string {
  return reason.length > REASON_CHARS ? `${reason.slice(0, REASON_CHARS - 1)}\u2026` : reason;
}

/**
 * The adapter's own words, not a house phrase.
 *
 * Collapsing every throw into one sentence made "Todo ABC-1 not found" and
 * "Employee dana not found" arrive identical, so the model could only say
 * something generic and the operator learned nothing. The reason is the whole
 * value of the failure.
 */
function executionReason(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
  return message ? clipReason(message) : "The gateway could not complete this operation.";
}

/** Name the check that did not match and the evidence actually found, so a
 *  verification failure is diagnosable instead of merely reported. */
function verificationReason(
  operation: NonNullable<ReturnType<typeof operationByName>>,
  verification: { evidence: Record<string, unknown> },
): string {
  const found = Object.entries(verification.evidence)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
  return clipReason(`${operation.name} did not match its ${operation.verification} check; ${found ? `found ${found}` : "nothing was found"}.`);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseArguments(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function fingerprint(input: TalkControlDispatch, args: Record<string, unknown>): string {
  return createHash("sha256").update(stable({
    tool: input.tool, args, providerItemId: input.providerItemId,
    providerEventId: input.providerEventId, providerTranscriptItemId: input.providerTranscriptItemId,
    browserInstanceId: input.browserInstanceId, credentialGeneration: input.credentialGeneration,
  })).digest("hex");
}

function matchesType(value: unknown, expected: unknown): boolean {
  switch (expected) {
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "object": return !!value && typeof value === "object" && !Array.isArray(value);
    default: return false;
  }
}

function propertyProblem(key: string, value: unknown, schema: unknown): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return `${key} has no valid schema.`;
  const typed = schema as Record<string, unknown>;
  if (!matchesType(value, typed.type)) return `${key} has the wrong type.`;
  if (Array.isArray(typed.enum) && !typed.enum.includes(value)) return `${key} is outside its allowed values.`;
  return null;
}

function argumentsProblem(args: Record<string, unknown>, operation: NonNullable<ReturnType<typeof operationByName>>): string | null {
  const properties = operation.parameters.properties as Record<string, unknown>;
  for (const required of operation.parameters.required) {
    if (!(required in args)) return `${required} is required.`;
  }
  for (const [key, value] of Object.entries(args)) {
    if (!(key in properties)) return `${key} is not allowed.`;
    const problem = propertyProblem(key, value, properties[key]);
    if (problem) return problem;
  }
  return null;
}

function preflight(
  input: TalkControlDispatch,
  operation: ReturnType<typeof operationByName>,
): { ok: true; operation: NonNullable<typeof operation>; args: Record<string, unknown> } | { ok: false; result: TalkControlFailure } {
  if (!operation) return { ok: false, result: failure("unknown-operation", `${clipReason(input.tool)} is not in the Talk manifest.`) };
  if (operation.target !== "gateway") return { ok: false, result: failure("wrong-target", `${operation.name} must execute in the browser.`) };
  if (operation.operatorOnly && input.caller.kind !== "operator") return { ok: false, result: failure("operator-required", "This operation requires the authenticated operator.") };
  if (!input.providerCallId || input.providerCallId.length > 200) return { ok: false, result: failure("invalid-provider-call", "A bounded provider call id is required.") };
  const args = parseArguments(input.arguments);
  if (!args) return { ok: false, result: failure("invalid-arguments", "Tool arguments must be a JSON object.") };
  const problem = argumentsProblem(args, operation);
  return problem
    ? { ok: false, result: failure("invalid-arguments", problem) }
    : { ok: true, operation, args };
}

function replayed(result: TalkControlResult): TalkControlResult {
  return result.ok ? { ...result, replayed: true } : result;
}

function retryableFailure(result: TalkControlResult): boolean {
  return !result.ok && (result.code === "execution-failed" || result.code === "verification-failed");
}

export class TalkControlRuntime {
  private readonly options: TalkControlRuntimeOptions;
  private readonly calls = new Map<string, HeldCall>();

  constructor(options: TalkControlRuntimeOptions) {
    this.options = options;
  }

  dispatch(input: TalkControlDispatch): Promise<TalkControlResult> {
    const checked = preflight(input, operationByName(this.options.manifest, input.tool));
    if (!checked.ok) return Promise.resolve(checked.result);

    const key = `${input.talkSessionId}:${input.providerCallId}`;
    const digest = fingerprint(input, checked.args);
    const existing = this.calls.get(key);
    if (existing) {
      if (existing.fingerprint !== digest) {
        return Promise.resolve(failure("provider-call-conflict", "This provider call id was already used for different input."));
      }
      return existing.promise.then(replayed);
    }

    const stored = this.options.receipts?.get(input.talkSessionId, input.providerCallId);
    if (stored) {
      return Promise.resolve(stored.requestFingerprint === digest
        ? replayed(stored.result)
        : failure("provider-call-conflict", "This provider call id was already used for different input."));
    }

    const promise = this.execute(input, checked.operation, checked.args).then((result) => {
      if (!result.ok || !this.options.receipts) return result;
      const receipt = this.options.receipts.put({
        talkSessionId: input.talkSessionId,
        providerCallId: input.providerCallId,
        requestFingerprint: digest,
        result,
        createdAt: (this.options.now ?? Date.now)(),
      });
      if (receipt.status === "conflict") {
        return failure("provider-call-conflict", "This provider call id was already used for different input.");
      }
      return receipt.status === "replayed" ? replayed(receipt.receipt.result) : result;
    }).then((result) => {
      if (retryableFailure(result)) this.calls.delete(key);
      return result;
    }).catch((error: unknown) => {
      this.calls.delete(key);
      throw error;
    });
    this.calls.set(key, { fingerprint: digest, promise });
    return promise;
  }

  private async execute(
    input: TalkControlDispatch,
    operation: NonNullable<ReturnType<typeof operationByName>>,
    args: Record<string, unknown>,
  ): Promise<TalkControlResult> {
    try {
      const execution = await this.options.execute(operation, args, {
        talkSessionId: input.talkSessionId,
        providerCallId: input.providerCallId,
        ...(input.providerItemId ? { providerItemId: input.providerItemId } : {}),
        ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
        ...(input.providerTranscriptItemId ? { providerTranscriptItemId: input.providerTranscriptItemId } : {}),
        ...(input.browserInstanceId ? { browserInstanceId: input.browserInstanceId } : {}),
        ...(input.credentialGeneration ? { credentialGeneration: input.credentialGeneration } : {}),
        idempotencyKey: `talk:${input.talkSessionId}:${input.providerCallId}`,
        caller: input.caller,
      });
      const verification = await this.options.verify(operation, args, execution);
      if (!verification.ok) {
        return failure("verification-failed", verificationReason(operation, verification));
      }
      const result: TalkControlSuccess = {
        ok: true,
        receiptId: randomUUID(),
        replayed: false,
        verified: true,
        operation: operation.name,
        data: execution.data,
        evidence: verification.evidence,
        uiEffect: execution.uiEffect,
      };
      return result;
    } catch (error) {
      if (error instanceof TalkControlRefusal) return failure(error.code, error.message);
      return failure("execution-failed", executionReason(error));
    }
  }
}
