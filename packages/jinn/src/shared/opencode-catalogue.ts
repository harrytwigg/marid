import type { ModelInfo } from "./types.js";
import { logger } from "./logger.js";
import { discoverOpencodeModels, settledWithin } from "./opencode-discovery.js";

/**
 * The opencode models discovery last found, and whether their `--verbose`
 * details (context windows, effort levels) are still to come.
 *
 * Until the details arrive, an opencode model's empty `effortLevels` means "not
 * known yet", not "none". Refusing an effort in that window, or dropping an
 * employee's configured one, loses the choice for good, so validation accepts a
 * level while the details are pending, and a turn that has one waits for them.
 *
 * Pending runs from the start of a refresh over a snapshot without details (the
 * first one, or one after `--verbose` failed) until that refresh has its
 * details, confirmed (see {@link land}), or knows there are none. A refresh over
 * a detailed snapshot never makes it pending, nor puts a plain list over it.
 */

let snapshot: ModelInfo[] | null = null;
let detailed = false;
let generation = 0;
let pending: { promise: Promise<void>; resolve: () => void } | undefined;
const listeners = new Set<() => void>();

/** One refresh's landing: its generation (only the newest lands), its binary,
 *  and what to tell when the snapshot changes (the registry's cache). */
interface Landing {
  refresh: number;
  bin: string;
  changed: () => void;
  /** Whether a first detailed answer still gets its second look. */
  confirm: boolean;
}

/** The discovered models, or null before any discovery found one. */
export function opencodeCatalogue(): ModelInfo[] | null {
  return snapshot;
}

/** Discover the models `bin` (null: opencode is not installed) can reach and
 *  keep them. Resolves once the catalogue to serve now is in; details that
 *  outlive the discovery timeout land later and tell {@link onLateOpencodeDetails}. */
export async function refreshOpencodeCatalogue(bin: string | null, changed: () => void): Promise<void> {
  generation += 1;
  if (!detailed && bin !== null) beginPending();
  const at: Landing = { refresh: generation, bin: bin ?? "", changed, confirm: true };
  if (bin === null) return land(at, null, false);
  try {
    const discovery = await discoverOpencodeModels(bin);
    logger.info(`opencode model discovery: ${discovery.models.length} model(s)`);
    const { details } = discovery;
    if (!details) return land(at, discovery.models, discovery.detailed);
    // The plain list stands in until the details land, but never over a
    // detailed snapshot from an earlier refresh: that one is the better answer.
    if (!detailed && at.refresh === generation) {
      snapshot = discovery.models;
      changed();
    }
    void details.then((models) => landLate(at, models));
  } catch (err) {
    logger.warn(`opencode model discovery failed: ${err instanceof Error ? err.message : err}`);
    land(at, null, false);
  }
}

function beginPending(): void {
  if (pending) return;
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => (resolve = r));
  pending = { promise, resolve };
}

/**
 * Put a refresh's answer in place. opencode 1.x's first run on a fresh home
 * lists the catalogue bundled in its binary while it fetches the current one
 * into its cache (on 1.19.0 the first `models --verbose` listed 11 bundled
 * models, the very next run the 10 current ones), so a model newer than the
 * binary would have no window or levels until the next refresh, hours away. The
 * first detailed answer is therefore served at once but confirmed by one more
 * run before the levels count as known. A warm home answers the same twice.
 */
function land(at: Landing, models: ModelInfo[] | null, isDetailed: boolean): void {
  if (at.refresh !== generation) return;
  const firstDetails = isDetailed && !detailed;
  snapshot = models;
  detailed = isDetailed;
  at.changed();
  if (firstDetails && at.confirm) void confirm(at);
  else settle(at.refresh);
}

async function confirm(at: Landing): Promise<void> {
  const again = await discoverOpencodeModels(at.bin);
  const models = again.detailed ? again.models : await again.details;
  if (at.refresh !== generation) return;
  logger.info(`opencode model discovery: ${models ? `confirmed with ${models.length} model(s)` : "the second look found nothing; keeping the first answer"}`);
  land({ ...at, confirm: false }, models ?? snapshot, models ? true : detailed);
  announce();
}

function landLate(at: Landing, models: ModelInfo[] | undefined): void {
  if (at.refresh !== generation) return;
  logger.info(models ? `opencode model discovery: details for ${models.length} model(s) arrived` : "opencode model discovery: --verbose gave nothing; keeping the plain list");
  land(at, models ?? snapshot, models ? true : detailed);
  announce();
}

function settle(refresh: number): void {
  if (refresh !== generation || !pending) return;
  pending.resolve();
  pending = undefined;
}

function announce(): void {
  for (const listener of listeners) listener();
}

/** Details that landed after their refresh returned changed the catalogue;
 *  the gateway tells the web UI, which otherwise refetches only on its own
 *  refresh. Returns the unsubscribe. */
export function onLateOpencodeDetails(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether `engine`'s effort levels cannot be known yet, so an effort must be
 *  neither refused nor dropped for want of them. */
export function effortLevelsPending(engine: string): boolean {
  return engine === "opencode" && pending !== undefined;
}

/** Resolves once {@link effortLevelsPending} clears for `engine`, or after
 *  `timeoutMs`; at once when it is not pending. */
export async function effortLevelsSettled(engine: string, timeoutMs: number): Promise<void> {
  if (effortLevelsPending(engine) && pending) await settledWithin(pending.promise, timeoutMs);
}
