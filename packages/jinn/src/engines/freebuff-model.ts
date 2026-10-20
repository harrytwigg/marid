import { logger } from "../shared/logger.js";

/**
 * Ids other engines use for a model: the Claude aliases, `claude-…` and `gpt-…` ids.
 * Freebuff's `/model` picker prints labels with spaces and capitals (`GPT-6 Luna`,
 * `Claude Haiku 5.5`), so none of these is one.
 */
const FOREIGN_MODEL_ID = /^(?:(?:sonnet|opus|haiku|fable)(?:\[[^\]]*\])?|(?:claude|gpt|o\d)-[a-z0-9.\-[\]]+)$/;

export function isForeignModelId(model: string): boolean {
  return FOREIGN_MODEL_ID.test(model.trim());
}

/**
 * The picker label prefix a turn should ask for. Employee files default to
 * `model: sonnet`, so an employee switched to this engine without editing it carries
 * a Claude alias that no picker row starts with, and every turn would fail on it. A
 * model that is not a picker label is set aside and the engine's own configured one
 * (else the CLI's choice) stands.
 */
export function pickerModelFor(requested: string | undefined, configured: string | undefined): string | undefined {
  const asked = requested?.trim();
  if (!asked) return configured?.trim() || undefined;
  if (!isForeignModelId(asked)) return asked;
  const fallback = configured?.trim() || undefined;
  logger.info(`FreebuffInteractiveEngine: "${asked}" is not a Freebuff model label; using ${fallback ? `engines.freebuff.model "${fallback}"` : "the CLI's own choice"}`);
  return fallback;
}
