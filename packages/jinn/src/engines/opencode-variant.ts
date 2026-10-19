import type { EngineRunOpts } from "../shared/types.js";
import { logger } from "../shared/logger.js";

/**
 * Reasoning effort, as opencode takes it: a model's VARIANT.
 *
 * opencode lists the variants each model has, and discovery turns them into
 * the model's `effortLevels` (shared/opencode-models.ts). A variant the model
 * does not have is an error at the provider, so the engine sends one only when
 * the turn's effort is one of the levels the registry knows for the turn's
 * model, and says nothing otherwise. The effort the session resolved was
 * validated against the model the SESSION names; a turn that runs on another
 * model (a fallback chain link names its own) needs this check again here,
 * against the model the turn actually runs.
 *
 * It is made once, when the engine accepts the turn ({@link withKnownEffort}),
 * so every transport reads `opts.effortLevel` as "the variant to send".
 */

/** The levels the registry knows for a model, or none. */
export type ModelEffortLevels = (model: string | undefined) => readonly string[];

const isLevel = (effort: string | undefined): effort is string => !!effort && effort !== "default";

/** `opts`, with an effort the turn's model does not list taken off it. */
export function withKnownEffort(opts: EngineRunOpts, levelsOf: ModelEffortLevels): EngineRunOpts {
  const effort = opts.effortLevel;
  if (!isLevel(effort)) return opts;
  if (levelsOf(opts.model).includes(effort)) return opts;
  logger.debug(`opencode: effort "${effort}" is not a variant of ${opts.model ?? "the default model"}, sending none`);
  return { ...opts, effortLevel: undefined };
}

/** The value `flags[i]` (a `--variant`) takes: the next token, unless that is
 *  missing or another flag. */
function valueAfter(flags: readonly string[], i: number): string | undefined {
  const value = flags[i + 1]?.trim();
  return value && !value.startsWith("-") ? value : undefined;
}

/** The value of a `--variant` in the operator's cliFlags (`--variant x` or
 *  `--variant=x`); the last one wins, as it does on opencode's command line. */
export function variantFromCliFlags(flags: readonly string[] | undefined): string | undefined {
  let found: string | undefined;
  flags?.forEach((flag, i) => {
    const value = flag === "--variant" ? valueAfter(flags, i) : flag.startsWith("--variant=") ? flag.slice("--variant=".length).trim() : undefined;
    if (value && !value.startsWith("-")) found = value;
  });
  return found;
}

/** cliFlags without any `--variant`, for a binary that takes the variant on the
 *  model instead (a flag it does not know would fail the turn). */
export function withoutVariantFlags(flags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (let i = 0; i < (flags?.length ?? 0); i++) {
    const flag = flags![i]!;
    if (flag === "--variant") {
      if (valueAfter(flags!, i)) i++;
    } else if (!flag.startsWith("--variant=")) out.push(flag);
  }
  return out;
}

/** The variant a turn sends: the operator's explicit `--variant`, else the
 *  turn's effort (already known to be one of the model's levels). */
export function variantOf(opts: Pick<EngineRunOpts, "effortLevel" | "cliFlags">): string | undefined {
  return variantFromCliFlags(opts.cliFlags) ?? (isLevel(opts.effortLevel) ? opts.effortLevel : undefined);
}

/** The cliFlags server mode has no equivalent for: everything but `--agent <x>`
 *  and `--variant`, which the prompt API takes. */
export function unsupportedServerFlags(flags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const rest = withoutVariantFlags(flags);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--agent") i++;
    else out.push(rest[i]!);
  }
  return out;
}

/** The variant Jinn adds to a `run` argv: the turn's effort, unless the
 *  operator's cliFlags already carry a `--variant`, which then wins. */
export function runVariantOf(opts: Pick<EngineRunOpts, "effortLevel" | "cliFlags">): string | undefined {
  return variantFromCliFlags(opts.cliFlags) ? undefined : variantOf(opts);
}

/** opencode 2's `run` has no `--variant`: the variant rides on the model, as
 *  `provider/model#variant`. */
export function modelWithVariant(model: string, variant: string | undefined): string {
  return variant ? `${model}#${variant}` : model;
}

/** A 2.x `Model.Ref`: the model and, when it has one, its variant. */
export interface V2ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** Whether a session's current model (as the 2.x API reports it) is `want`.
 *  The server reports a session with no variant as `"default"`, and one set
 *  without as nothing at all: both are "no variant". */
export function sameModelRef(current: Record<string, unknown> | undefined, want: V2ModelRef): boolean {
  const variant = typeof current?.variant === "string" && current.variant !== "default" && current.variant !== "" ? current.variant : undefined;
  return current?.providerID === want.providerID && current?.id === want.id && variant === want.variant;
}
