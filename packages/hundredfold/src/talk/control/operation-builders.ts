/**
 * How a Talk operation is declared.
 *
 * Split out of `manifest.ts` so a domain can own its own entries without either
 * file importing the other back.
 */
import type { JsonObject } from "../../shared/types.js";
import type { TalkControlOperation, TalkControlParameters } from "./types.js";

export const string = (description: string, values?: readonly string[]): JsonObject => ({
  type: "string",
  description,
  ...(values ? { enum: [...values] } : {}),
});

export const integer = (description: string): JsonObject => ({ type: "integer", description });

export function params(properties: JsonObject, required: string[] = []): TalkControlParameters {
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * A gateway operation. Every write is `operatorOnly` by construction: the
 * authority to mutate the company is the operator's, and a manifest entry
 * cannot opt out of it by forgetting a field.
 */
export function gateway(
  name: string,
  description: string,
  parameters: TalkControlParameters,
  intent: string,
  policy: { mutability: "read" | "write"; verification: string },
): TalkControlOperation {
  return {
    name,
    description,
    parameters,
    target: "gateway",
    intent,
    mutability: policy.mutability,
    operatorOnly: policy.mutability === "write",
    verification: policy.verification,
  };
}
