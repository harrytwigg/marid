/**
 * What a domain adapter is handed, and what every one of them needs.
 *
 * Its own module so a domain can live in its own file without importing the
 * registry that dispatches to it.
 */
import type { ApiContext } from "../../gateway/api.js";
import type {
  TalkControlAdapterContext,
  TalkControlExecution,
  TalkControlReceiptStore,
} from "./types.js";

export interface TalkControlHost {
  context: ApiContext;
  sourceSessionId: string;
  receipts?: TalkControlReceiptStore;
}

export type DomainHandler = (
  host: TalkControlHost,
  args: Record<string, unknown>,
  call: TalkControlAdapterContext,
) => TalkControlExecution | Promise<TalkControlExecution>;

/** A required argument, trimmed. The throw is the operator's answer now that
 *  the runtime carries an adapter's own words, so it names the field. */
export function requiredText(args: Record<string, unknown>, key: string): string {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  if (!value) throw new Error(`${key} is required`);
  return value;
}
