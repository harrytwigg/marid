import type { EngineRunOpts } from "../shared/types.js";
import { MUSECODE_EFFORT_VOCABULARY } from "../shared/musecode-effort.js";
import { logger } from "../shared/logger.js";
import { buildOpencodePrompt } from "./opencode-protocol.js";
import type { ModelEffortLevels } from "./opencode-variant.js";

/**
 * Muse Code's wire contract, as pure functions: the argv of its MSP host, the
 * prompt it is handed, and the small vocabularies the adapter reads.
 *
 * Kept apart from the engine so a short-lived `muse serve` started for something
 * other than a turn (model discovery, usage reads) is spawned with exactly the
 * flags a turn's host is.
 */

/**
 * Settings every host the gateway starts carries.
 *
 * `context.foreign_personal_*` stop Muse loading the operator's own `~/.claude`
 * and codex rules and skills into a session: an employee's instructions come
 * from jinn, and a second set from whichever CLI the operator also uses would
 * change what it does between machines.
 */
const BASE_SERVE_ARGS = [
  "serve",
  // The OS sandbox needs a capability this kind of host often lacks, and
  // jinn runs its other unattended engines unsandboxed too.
  "--disable-sandbox",
  // Without it a headless host does not load the workspace's own CLAUDE.md or
  // AGENTS.md (nor its skills and hooks), so an employee would lose its project
  // instructions with no sign. Claude loads them unasked. Trust is for this run
  // only; Muse saves nothing.
  "--trust-workspace",
  "-c", "context.foreign_personal_rules=false",
  "-c", "context.foreign_personal_skills=false",
];

/** `muse serve`'s argv for a session's host: the base flags, the model, then the operator's own `cliFlags`. */
export function buildMuseServeArgs(opts: Pick<EngineRunOpts, "model" | "cliFlags">): string[] {
  return [
    ...BASE_SERVE_ARGS,
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.cliFlags ?? []),
  ];
}

/** The text of the turn: the system prompt joined on a fresh session only, as opencode's, and any non-image attachment named. */
export function buildMusecodePrompt(opts: EngineRunOpts): string {
  return buildOpencodePrompt(opts);
}

/** The model, for a log line. */
export function describeMusecodeLaunch(opts: Pick<EngineRunOpts, "model">): string {
  return `--model ${opts.model || "(muse default)"}`;
}

/** The `reasoningEffort` to send, or undefined when the level is unset, `none` or not one Muse knows. */
export function museReasoningEffort(level: string | undefined): string | undefined {
  if (!level || level === "none") return undefined;
  return (MUSECODE_EFFORT_VOCABULARY as readonly string[]).includes(level) ? level : undefined;
}

/**
 * The `reasoningEffort` a turn sends: {@link museReasoningEffort}'s, and, where the
 * engine knows each model's levels (`levelsOf`), only one the turn's own model lists.
 * The session checked the effort against the model it names, which a catalog may not
 * list, and a fallback runs the turn on another; a level the model rejects would fail
 * the turn, so it is dropped (and logged) instead.
 */
export function museTurnEffort(opts: Pick<EngineRunOpts, "effortLevel" | "model">, levelsOf?: ModelEffortLevels): string | undefined {
  const effort = museReasoningEffort(opts.effortLevel);
  if (!effort || !levelsOf || levelsOf(opts.model).includes(effort)) return effort;
  logger.debug(`Muse Code: effort "${effort}" is not a level of ${opts.model ?? "the default model"}, sending none`);
  return undefined;
}

/** The server's own words for a turn that failed because the user is not signed in. */
export const MUSECODE_AUTH_HELP =
  "Muse Code is not signed in. Run `muse login` on the host the session runs on (the gateway, or the employee's remote host), or set META_API_KEY in that host's environment, then retry.";

/** The answer to an `approval/request`: the id of an `availableChoices` entry that allows the call, preferring a one-off allow. */
export function allowingChoiceId(choices: unknown): string | undefined {
  if (!Array.isArray(choices)) return undefined;
  const allowing = choices.filter((c): c is Record<string, unknown> => {
    if (!c || typeof c !== "object") return false;
    const decision = (c as Record<string, unknown>).decision;
    return typeof (c as Record<string, unknown>).choiceId === "string" && (decision === "approved" || decision === "approvedForSession");
  });
  const once = allowing.find((c) => c.scope === "once" && c.decision === "approved");
  return ((once ?? allowing[0])?.choiceId as string | undefined);
}
