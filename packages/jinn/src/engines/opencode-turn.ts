import type { EngineResult, StreamDelta } from "../shared/types.js";
import { isRateLimitMessage } from "../shared/rateLimit.js";
import { extractActivityReceiptId } from "../shared/activity-receipts.js";
import {
  asRecord,
  contextTokensFromStep,
  describeToolCall,
  numberOr,
  opencodeErrorText,
  parseEventLine,
  toolIdentity,
  trimmedString,
  type StepTokens,
} from "./opencode-protocol.js";

/**
 * One opencode turn, accumulated from its event stream.
 *
 * Separate from the engine because it is the half that can be tested without a
 * process: feed it the lines opencode actually prints and ask what the turn
 * became. The engine owns spawning, killing and timing out; this owns what the
 * turn MEANS, and the two meet at `readLine` and `result`.
 *
 * Transport-agnostic by construction — a local run and one carried over ssh
 * produce the same lines, so neither is special-cased here.
 */
/** What a turn that a host's fallback plugin ended says: the plugin is named, and the turn counts as a usage limit. */
export const FALLBACK_PLUGIN_ENDED_TURN =
  "This host's opencode has a model-fallback plugin (see `jinn doctor`), which aborts a turn at a usage limit and re-sends the prompt on another model; "
  + "the gateway does not follow that re-send, so this counts as a usage limit and its fallback chain takes over. Remove the plugin.";

export class OpencodeTurn {
  /** The answer: the last non-empty text part wins. */
  private resultText = "";
  private turnError: string | null = null;
  /** The turn's last word was an error: no text came after it. */
  private endedInError = false;
  /** The model said something or ran a tool: the session is alive. */
  private producedOutput = false;
  /** Model round trips. A turn that called tools has more than one. */
  private steps = 0;
  private cost = 0;
  private contextTokens: number | undefined;
  /** opencode assigns this; until it speaks, the id we asked it to resume. */
  private sessionId: string;

  /** @param fallbackPluginOnHost whether the host's opencode carries a model-fallback
   *  plugin (opencode-internal-fallback.ts), read when the turn ends. */
  constructor(resumeSessionId: string, private readonly fallbackPluginOnHost: () => boolean = () => false) {
    this.sessionId = resumeSessionId;
  }

  /** One stdout line of the JSON event stream. */
  readLine(line: string, onStream: ((delta: StreamDelta) => void) | null): void {
    const event = parseEventLine(line);
    if (!event) return;

    // Every event carries it, including the `error` one — so a turn that failed
    // before producing anything still reports the session it failed in, and the
    // next turn resumes rather than silently starting a new conversation.
    const sessionId = trimmedString(event.sessionID);
    if (sessionId) this.sessionId = sessionId;

    const part = asRecord(event.part) ?? {};
    switch (event.type) {
      case "text":
        this.readText(part, onStream);
        break;
      case "tool_use":
        this.readToolUse(part, onStream);
        break;
      case "step_finish":
        this.readStepFinish(part);
        break;
      case "error":
        this.turnError = opencodeErrorText(event);
        this.endedInError = true;
        break;
    }
  }

  private readText(part: Record<string, unknown>, onStream: ((delta: StreamDelta) => void) | null): void {
    const text = typeof part.text === "string" ? part.text : "";
    if (!text) return;
    // A turn that called tools emits one text part per step, and the answer is
    // the one after the last tool round trip.
    this.resultText = text;
    this.endedInError = false;
    this.producedOutput = true;
    if (onStream) onStream({ type: "text", content: text });
  }

  private readToolUse(part: Record<string, unknown>, onStream: ((delta: StreamDelta) => void) | null): void {
    this.producedOutput = true;
    if (!onStream) return;
    const identity = toolIdentity(part);
    const state = asRecord(part.state) ?? {};

    onStream({
      type: "tool_use",
      content: describeToolCall(identity.toolName, asRecord(state.input)),
      ...identity,
    });

    // A tool part is reported at whatever state it reached. `pending` and
    // `running` have no output yet, so only the two terminal states produce a
    // result — verified against opencode's own status union.
    const status = trimmedString(state.status);
    if (status !== "completed" && status !== "error") return;
    const output = typeof state.output === "string" ? state.output : "";
    const activityReceiptId = extractActivityReceiptId(output, { isError: status === "error" });
    onStream({
      type: "tool_result",
      content: output.slice(0, 500),
      ...identity,
      ...(activityReceiptId ? { activityReceiptId } : {}),
    });
  }

  /** One model round trip finished. A turn is several of these, so cost
   *  ACCUMULATES and the context reading is whichever step spoke last. */
  private readStepFinish(part: Record<string, unknown>): void {
    this.steps += 1;
    this.cost += numberOr(part.cost, 0);
    const context = contextTokensFromStep(asRecord(part.tokens) as StepTokens | undefined);
    if (context !== undefined) this.contextTokens = context;
  }

  /** The turn's step accounting, as far as it went. */
  private accounting(): Pick<EngineResult, "numTurns" | "cost" | "contextTokens"> {
    return {
      ...(this.steps > 0 ? { numTurns: this.steps } : {}),
      ...(this.cost > 0 ? { cost: this.cost } : {}),
      ...(this.contextTokens === undefined ? {} : { contextTokens: this.contextTokens }),
    };
  }

  /**
   * What this turn became, once the process is gone.
   *
   * `failure` is a transport that went away mid-turn — the opencode server's
   * event stream closing or erroring, which `OpencodeServerTurn` records —
   * rather than an error the engine reported itself. It settles the turn as a
   * failure even when a step had already spoken: that text is earlier-steps
   * narration, and a lost turn must not pass for an answer, or the session
   * settles `completed` with no error and nothing resumes the work.
   */
  result(outcome: { code: number | null; terminationReason: string | null; stderr: string; failure?: string; noAnswer?: string }): EngineResult {
    const accounting = this.accounting();

    if (outcome.terminationReason) {
      return { sessionId: this.sessionId, result: "", error: outcome.terminationReason, ...accounting };
    }
    // A non-empty answer means the turn succeeded even if an error also
    // appeared — unless the error came after the last text, or the transport
    // carrying the turn failed outright. Then the turn stopped partway: the
    // text was an earlier step's narration ("Let me check X first"), and a
    // provider refusing the next step, or a stream that went away, is the
    // turn's outcome.
    if (!outcome.failure && this.resultText.trim() && !this.endedInError) {
      return { sessionId: this.sessionId, result: this.resultText, ...accounting };
    }

    const { error, plugin } = this.failureOf(outcome);
    return {
      sessionId: this.sessionId,
      result: "",
      error,
      ...accounting,
      // A turn that said something or ran a tool before it failed ran in a live
      // session, even if no step finished (an error, or an Esc, mid-step). Zero
      // turns and zero cost is what `isDeadSessionError` reads as a stale resume
      // id, and the next turn would lose the conversation.
      ...(this.producedOutput && this.steps === 0 ? { numTurns: 1 } : {}),
      // Said outright rather than left to be inferred from the text. A usage
      // limit that lands before the first step leaves zero cost and zero turns,
      // which is exactly the shape `isDeadSessionError` reads as a stale resume
      // id — and it is consulted BEFORE `detectRateLimit`, so without this the
      // session id would be wiped and the engine chain never walked.
      ...(plugin || isRateLimitMessage(error) ? { rateLimit: { status: "rejected" } } : {}),
    };
  }

  /** The error of a turn with no accepted answer, and whether a host's fallback plugin ended it. */
  private failureOf(outcome: { code: number | null; stderr: string; failure?: string; noAnswer?: string }): { error: string; plugin: boolean } {
    const error = outcome.failure || this.outcomeError(outcome);
    const plugin = this.endedByFallbackPlugin(outcome);
    return { error: plugin ? `${error}. ${FALLBACK_PLUGIN_ENDED_TURN}` : error, plugin };
  }

  /** A turn that ended with nothing, on a host whose opencode has a model-fallback
   *  plugin: the plugin aborts a turn at a usage limit and re-sends the prompt, which
   *  ends it with no answer and no error of its own. Not for a failure of the transport,
   *  or an error that is not a usage limit. */
  private endedByFallbackPlugin(outcome: { code: number | null; failure?: string }): boolean {
    if (outcome.failure || outcome.code !== 0 || !this.fallbackPluginOnHost()) return false;
    return !this.turnError || isRateLimitMessage(this.turnError);
  }

  /** Why a turn that produced no accepted answer failed: whatever opencode
   *  reported, or — having reported nothing — why ending without one is still a
   *  failure. A transport `failure` is passed in separately; it is not
   *  something opencode reported. `noAnswer` names the end of a turn that no
   *  process exit ended (a server turn). */
  private outcomeError(outcome: { code: number | null; stderr: string; noAnswer?: string }): string {
    return this.turnError
      || (outcome.code === 0
        ? outcome.noAnswer ?? "opencode exited successfully without a final assistant response"
        : `opencode exited with code ${outcome.code}: ${outcome.stderr.slice(0, 500)}`);
  }
}
