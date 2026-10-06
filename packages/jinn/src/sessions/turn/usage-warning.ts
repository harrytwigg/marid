import { accountForEmployee } from "../../shared/engine-account.js";
import { getClaudeExpectedResetAt, isLikelyNearClaudeUsageLimit } from "../../shared/usageAwareness.js";
import { formatResumeTime } from "./text.js";
import type { TurnInput, TurnPlan, TurnSurface } from "./types.js";

/** A prompt this long, on a heavy model, is worth warning about before spending it. */
const HEAVY_PROMPT_CHARS = 6000;
const HEAVY_EFFORTS = new Set(["high", "xhigh", "max"]);

/** A turn big enough that pausing it on a usage limit would actually hurt. */
function isExpensiveTurn(input: TurnInput, plan: TurnPlan): boolean {
  const heavyRun = HEAVY_EFFORTS.has((plan.effortLevel || "").toLowerCase())
    || (plan.model ?? "").toLowerCase().includes("opus");
  const bigInput = input.attachments.length > 0 || input.prompt.length > HEAVY_PROMPT_CHARS;
  return heavyRun && bigInput;
}

/**
 * Claude usage limits expose no remaining budget, so a heavy turn started just
 * after a limit was hit is worth a heads-up before it is spent.
 */
export async function warnIfNearUsageLimit(input: TurnInput, plan: TurnPlan, surface: TurnSurface): Promise<void> {
  if (!input.announceUsageWarnings || plan.engineName !== "claude") return;
  // The memory of the account this turn runs on: a named profile's limit is not the operator's.
  const account = accountForEmployee(input.employee, "claude");
  if (!isLikelyNearClaudeUsageLimit(undefined, account) || !isExpensiveTurn(input, plan)) return;

  const resumeText = formatResumeTime(getClaudeExpectedResetAt(undefined, account));
  await surface.notice(
    `⚠️ Heads up: Claude usage limits were hit recently, and this looks like a bigger task. If you're near the limit, it may pause${resumeText ? ` until ~${resumeText}` : ""}.`,
  );
}
