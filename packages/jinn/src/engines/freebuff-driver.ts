import { logger } from "../shared/logger.js";
import type { FreebuffTerminal } from "./freebuff-terminal.js";
import { parseFreebuffScreen, type FreebuffRefusal, type FreebuffScreenInfo } from "./freebuff-screen.js";
import {
  choiceSatisfied,
  chooseInPicker,
  FreebuffPickerError,
  type PickerChoice,
  type PickerIO,
  type PickerKey,
} from "./freebuff-picker.js";
import {
  FreebuffFailure,
  SessionReleased,
  refusalFailure,
  screenFailure,
  type FreebuffPlace,
} from "./freebuff-failure.js";
import { FinishWatch, UnknownScreenWatch } from "./freebuff-turn-watch.js";

const POLL_MS = 200;
const PICKER_OPEN_MS = 15_000;
const KEY_PATIENCE_MS = 1_500;
const KEY_SETTLE_MS = 150;
const PASTE_CHUNK = 8 * 1024;

const KEY_BYTES: Record<PickerKey, string> = { up: "\x1b[A", down: "\x1b[B", tab: "\t", enter: "\r", escape: "\x1b" };

/** The part of a Freebuff process the driver types into and reads. */
export interface DriverTarget {
  proc: { write(data: string): void };
  terminal: FreebuffTerminal;
  place: FreebuffPlace;
  /** Set once the TUI has drawn something recognisable, so a process that died before then reads as a failed start. */
  markBooted(): void;
}

/** Sleep that ends early, throwing the signal's reason, when the turn stops. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A refusal the CLI printed: a failure to report, or a dropped session to start over from. */
function refused(refusal: FreebuffRefusal): never {
  throw refusalFailure(refusal) ?? new SessionReleased(refusal.text);
}

/** The choice with `default` and blanks taken out, or undefined when nothing is asked for. */
function wantedChoice(choice: PickerChoice): PickerChoice | undefined {
  const effortLevel = choice.effortLevel && choice.effortLevel !== "default" ? choice.effortLevel : undefined;
  if (!choice.model && !effortLevel) return undefined;
  return { ...(choice.model ? { model: choice.model } : {}), ...(effortLevel ? { effortLevel } : {}) };
}

function describeChoice(choice: PickerChoice): string {
  return `${choice.model ?? "(the current model)"}${choice.effortLevel ? ` • ${choice.effortLevel}` : ""}`;
}

function describeBar(bar: FreebuffScreenInfo["statusBar"]): string {
  return bar ? `${bar.modelLabel}${bar.effort ? ` • ${bar.effort}` : ""}` : "unreadable";
}

/**
 * Types into and reads a Freebuff process for the length of one turn. Every wait
 * ends early, by throwing the turn's stop reason, when the turn is stopped.
 */
export class FreebuffDriver {
  constructor(private readonly target: DriverTarget, private readonly signal: AbortSignal) {}

  /** The screen as it is once everything written so far has been drawn. */
  async screen(): Promise<{ lines: string[]; info: FreebuffScreenInfo }> {
    await this.target.terminal.settled();
    const lines = this.target.terminal.lines().map((l) => l.trimEnd());
    const info = parseFreebuffScreen(lines);
    if (info.state !== "unknown" && info.state !== "signed-out") this.target.markBooted();
    return { lines, info };
  }

  /**
   * Poll the screen until `done` says so. Fails the turn on the screens that mean
   * it cannot go on (signed out, no hours, a refusal), and on one nothing
   * recognises for a minute, with that screen in the error.
   */
  async waitForState(done: (info: FreebuffScreenInfo) => boolean, opts: { what: string; timeoutMs?: number }): Promise<FreebuffScreenInfo> {
    const startedAt = Date.now();
    const unknown = new UnknownScreenWatch();
    for (;;) {
      await sleep(POLL_MS, this.signal);
      const { lines, info } = await this.screen();
      const failure = screenFailure(info, this.target.place);
      if (failure) throw failure;
      if (info.refusal) refused(info.refusal);
      if (done(info)) return info;
      unknown.check(info, lines);
      if (opts.timeoutMs !== undefined && Date.now() - startedAt >= opts.timeoutMs) {
        throw new FreebuffFailure(`Freebuff did not reach its ${opts.what} screen within ${Math.round(opts.timeoutMs / 1000)}s`);
      }
    }
  }

  /** The picker's keys, with the pacing the TUI needs: one key, then the redraw it causes. */
  private pickerIO(): PickerIO {
    return {
      screen: async () => (await this.screen()).lines,
      press: async (key) => { this.target.proc.write(KEY_BYTES[key]); },
      nextScreen: async (previous) => {
        const before = previous.join("\n");
        const deadline = Date.now() + KEY_PATIENCE_MS;
        let latest = previous;
        while (Date.now() < deadline) {
          await sleep(80, this.signal);
          latest = (await this.screen()).lines;
          if (latest.join("\n") === before) continue;
          // The TUI drops keys that land mid-redraw: let it finish drawing.
          await sleep(KEY_SETTLE_MS, this.signal);
          return (await this.screen()).lines;
        }
        return latest;
      },
    };
  }

  /** Make the status bar show the wanted model and level, opening `/model` only if it does not already. */
  async ensureModel(choice: PickerChoice): Promise<void> {
    const wanted = wantedChoice(choice);
    if (!wanted) return;
    const { info } = await this.screen();
    if (choiceSatisfied(wanted, info.statusBar)) return;

    logger.info(`FreebuffInteractiveEngine: switching to ${describeChoice(wanted)} (status bar: ${describeBar(info.statusBar)})`);
    this.target.proc.write("/model");
    await sleep(400, this.signal);
    this.target.proc.write("\r");
    await this.waitForState((i) => i.state === "picker", { what: "model picker", timeoutMs: PICKER_OPEN_MS });
    await this.choose(wanted);

    const after = await this.waitForState((i) => i.state === "idle", { what: "idle", timeoutMs: PICKER_OPEN_MS });
    if (choiceSatisfied(wanted, after.statusBar)) return;
    throw new FreebuffFailure(`Freebuff did not switch to ${describeChoice(wanted)}; its status bar shows ${describeBar(after.statusBar)}`);
  }

  private async choose(wanted: PickerChoice): Promise<void> {
    try {
      const { warnings } = await chooseInPicker(this.pickerIO(), wanted);
      for (const warning of warnings) logger.warn(`FreebuffInteractiveEngine: ${warning}`);
    } catch (err) {
      if (err instanceof FreebuffPickerError) throw new FreebuffFailure(`Freebuff model selection failed: ${err.message}`);
      throw err;
    }
  }

  /** Bracketed paste, so a multi-line message arrives as one message and its newlines do not submit; then Enter. */
  async submit(text: string): Promise<void> {
    const { proc } = this.target;
    proc.write("\x1b[200~");
    for (let i = 0; i < text.length; i += PASTE_CHUNK) {
      proc.write(text.slice(i, i + PASTE_CHUNK));
      if (text.length > PASTE_CHUNK) await sleep(15, this.signal);
    }
    proc.write("\x1b[201~");
    await sleep(Math.min(3_000, 300 + Math.floor(text.length / 40)), this.signal);
    proc.write("\r");
  }

  /**
   * Busy, then idle again with the footer held for a moment (see {@link FinishWatch}).
   * `answered` is asked when the input stayed idle and never went busy: a turn short
   * enough to have come and gone between looks has left its answer in the chat.
   */
  async waitForFinish(answered: () => Promise<boolean>): Promise<{ info: FreebuffScreenInfo; lines: string[] }> {
    const watch = new FinishWatch(this.target.place, Date.now());
    for (;;) {
      await sleep(POLL_MS, this.signal);
      const { lines, info } = await this.screen();
      const verdict = watch.observe(info, lines);
      if (verdict === "done") return { info, lines };
      if (verdict === "stalled" && await answered()) return { info, lines };
      if (verdict === "stalled") throw notTaken(lines);
    }
  }
}

function notTaken(lines: readonly string[]): FreebuffFailure {
  const shown = lines.filter((l) => l.trim()).slice(-12).join("\n");
  return new FreebuffFailure(`Freebuff did not take the message: its input stayed idle for 30s after submit:\n${shown}`);
}
