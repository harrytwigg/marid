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
 * first one, or one after `--verbose` failed) until details land (from that
 * refresh or one it overtook), are confirmed (see {@link land}), or are known
 * not to be coming. A refresh over a detailed snapshot never makes it pending,
 * and a slow one never puts its stand-in plain list over that snapshot.
 */

let snapshot: ModelInfo[] | null = null;
let detailed = false;
let generation = 0;
let pending: { promise: Promise<void>; resolve: () => void } | undefined;
/** Whether a first detailed answer's second look is still running. */
let confirming = false;
const listeners = new Set<() => void>();

/** One refresh's landing: its generation, its binary, and what to tell when
 *  the snapshot changes (the registry's cache). */
interface Landing {
  refresh: number;
  bin: string;
  changed: () => void;
  /** Whether a first detailed answer gets its second look (see {@link land}). */
  secondLook: boolean;
}

/** The discovered models, or null before any discovery found one. */
export function opencodeCatalogue(): ModelInfo[] | null {
  return snapshot;
}

/** Discover the models `bin` (null: opencode is not installed) can reach and
 *  keep them. Resolves once the catalogue to serve now is in; details that
 *  outlive the discovery timeout land later and tell {@link onLateOpencodeDetails}.
 *  `secondLook` is the gateway's: a CLI command reads the catalogue once and exits. */
export async function refreshOpencodeCatalogue(bin: string | null, changed: () => void, secondLook = false): Promise<void> {
  generation += 1;
  if (!detailed && bin !== null) beginPending();
  const at: Landing = { refresh: generation, bin: bin ?? "", changed, secondLook };
  if (bin === null) return land(at, null, false);
  try {
    const discovery = await discoverOpencodeModels(bin);
    logger.info(`opencode model discovery: ${discovery.models.length} model(s)`);
    const { details } = discovery;
    if (!details) return land(at, discovery.models, discovery.detailed);
    standIn(at, discovery.models);
    void details.then((models) => landLate(at, models));
  } catch (err) {
    logger.warn(`opencode model discovery failed: ${err instanceof Error ? err.message : err}`);
    land(at, null, false);
  }
}

/** The plain list stands in until the details land, but never over a detailed
 *  snapshot from an earlier refresh: that one is the better answer. */
function standIn(at: Landing, models: ModelInfo[]): void {
  if (detailed || at.refresh !== generation) return;
  snapshot = models;
  at.changed();
}

function beginPending(): void {
  if (pending) return;
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => (resolve = r));
  pending = { promise, resolve };
}

/**
 * Put a refresh's answer in place. The newest refresh's answer always lands. An
 * overtaken one's lands only when it brings details the snapshot lacks, since
 * the newer refresh may never bring them.
 *
 * opencode 1.x's first run on a fresh home lists the catalogue bundled in its
 * binary while it fetches the current one into its cache (on 1.19.0 the first
 * `models --verbose` listed 11 bundled models, the very next run the 10 current
 * ones), so a model newer than the binary would have no window or levels until
 * the next refresh, hours away. So the gateway's first detailed answer is served
 * at once and confirmed by one more run; until then only a model that answer
 * does not list counts as pending. A warm home answers the same twice.
 */
function land(at: Landing, models: ModelInfo[] | null, isDetailed: boolean): void {
  const current = at.refresh === generation;
  if (!current && !(isDetailed && !detailed)) return;
  const firstDetails = isDetailed && !detailed;
  snapshot = models;
  detailed = isDetailed;
  at.changed();
  if (firstDetails && at.secondLook) {
    confirming = true;
    void confirm(at);
  } else if (current || detailed) {
    settle();
  }
}

async function confirm(at: Landing): Promise<void> {
  const again = await discoverOpencodeModels(at.bin);
  const models = again.detailed ? again.models : await again.details;
  confirming = false;
  // A newer refresh has answered for itself; this look only settles the wait.
  if (models && at.refresh === generation) {
    snapshot = models;
    at.changed();
  }
  logger.info(`opencode model discovery: ${models ? `second look found ${models.length} model(s)` : "the second look found nothing; keeping the first answer"}`);
  settle();
  announce();
}

function landLate(at: Landing, models: ModelInfo[] | undefined): void {
  if (at.refresh !== generation && !(models && !detailed)) return;
  logger.info(models ? `opencode model discovery: details for ${models.length} model(s) arrived` : "opencode model discovery: --verbose gave nothing; keeping the plain list");
  land(at, models ?? snapshot, models ? true : detailed);
  announce();
}

function settle(): void {
  if (!pending) return;
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

/** Whether `engine`'s effort levels for `modelId` (unnamed: whichever model
 *  the turn ends up on) cannot be known yet, so an effort must be neither
 *  refused nor dropped for want of them. */
export function effortLevelsPending(engine: string, modelId?: string): boolean {
  if (engine !== "opencode" || !pending) return false;
  const listed = modelId !== undefined && (snapshot?.some((m) => m.id === modelId) ?? false);
  return !(confirming && listed);
}

/** Resolves once {@link effortLevelsPending} clears, or after `timeoutMs`; at
 *  once when it is not pending. */
export async function effortLevelsSettled(engine: string, timeoutMs: number, modelId?: string): Promise<void> {
  if (effortLevelsPending(engine, modelId) && pending) await settledWithin(pending.promise, timeoutMs);
}
