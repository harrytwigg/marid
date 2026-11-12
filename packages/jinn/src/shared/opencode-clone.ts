/**
 * What an opencode account clones from its base provider's catalogue entries
 * (docs/design/opencode-accounts.md, "Catalogue cloning"): each model's SDK
 * package, endpoint, price, limits and variants, kept apart from the plain
 * model list because only a base provider's models need them.
 *
 * Only these fields are kept. In 2.x's `api model.list`, `settings` can carry a
 * resolved `apiKey`; nothing but `settings.baseURL` is read from it, so no key
 * can reach a catalogue, a staged file or a log line through here.
 */

/** A model's price as opencode's config takes it, in USD per million tokens. */
export interface OpencodeCloneCost {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** One base-provider model, as an account's provider block clones it. */
export interface OpencodeCloneModel {
  /** The model id without its provider. */
  id: string;
  name?: string;
  /** The SDK package as the catalogue names it (`@opencode/ai/providers/<sdk>` on 2.x, `@ai-sdk/<sdk>` on 1.x). */
  npm?: string;
  /** The endpoint this model is served from. */
  endpoint?: string;
  limit?: { context?: number; input?: number; output?: number };
  cost?: OpencodeCloneCost;
  /** Effort variants by id, each the options it sets (the shape of a config `variants` block). */
  variants?: Record<string, Record<string, unknown>>;
}

/** The records kept for the base providers an account names, by provider id. */
export type OpencodeClones = ReadonlyMap<string, readonly OpencodeCloneModel[]>;

/** Collects clone records while a catalogue is parsed. Records are kept only for `providers`. */
export interface CloneSink {
  readonly providers: ReadonlySet<string>;
  readonly models: Map<string, OpencodeCloneModel[]>;
}

export function newCloneSink(providers: Iterable<string>): CloneSink {
  return { providers: new Set(providers), models: new Map() };
}

/** Move what `from` collected into `into`, replacing a provider's earlier records. */
export function adoptClones(into: CloneSink, from: CloneSink): void {
  for (const [provider, models] of from.models) into.models.set(provider, models);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** `{input, output, cache: {read, write}}` (both versions' record shape; 1.x adds `tiers`, which is dropped) as a config `cost`. Absent when it does not state an input and an output price. */
export function costFromRecord(value: unknown): OpencodeCloneCost | undefined {
  if (!isRecord(value)) return undefined;
  const input = nonNegative(value.input);
  const output = nonNegative(value.output);
  if (input === undefined || output === undefined) return undefined;
  const cache = isRecord(value.cache) ? value.cache : {};
  return { input, output, cache_read: nonNegative(cache.read) ?? 0, cache_write: nonNegative(cache.write) ?? 0 };
}

function limitFromRecord(value: unknown): OpencodeCloneModel["limit"] {
  if (!isRecord(value)) return undefined;
  const limit: NonNullable<OpencodeCloneModel["limit"]> = {};
  const context = positive(value.context);
  const input = positive(value.input);
  const output = positive(value.output);
  if (context !== undefined) limit.context = context;
  if (input !== undefined) limit.input = input;
  if (output !== undefined) limit.output = output;
  return Object.keys(limit).length > 0 ? limit : undefined;
}

/** `variants` as a config block: 1.x's object keyed by level, or 2.x's `[{id, settings}]`. */
function variantsFromRecord(value: unknown): OpencodeCloneModel["variants"] {
  const entries = Array.isArray(value) ? variantEntriesOfList(value) : isRecord(value) ? Object.entries(value) : [];
  const variants = Object.fromEntries(entries.map(([id, settings]) => [id, isRecord(settings) ? { ...settings } : {}]));
  return Object.keys(variants).length > 0 ? variants : undefined;
}

/** 2.x's `[{id, settings}]` as `[id, settings]` pairs, leaving out an entry with no id. */
function variantEntriesOfList(list: unknown[]): Array<[string, unknown]> {
  return list.flatMap((entry) => (isRecord(entry) && typeof entry.id === "string" && entry.id !== "" ? [[entry.id, entry.settings] as [string, unknown]] : []));
}

function withFields(id: string, fields: Omit<OpencodeCloneModel, "id">): OpencodeCloneModel {
  const model: OpencodeCloneModel = { id };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (model as unknown as Record<string, unknown>)[key] = value;
  }
  return model;
}

/** One 2.x `model.list` record: `package`, `settings.baseURL` (nothing else of `settings`), `limit`, `cost[0]`, `variants`. */
export function cloneFromApiRecord(modelId: string, record: Record<string, unknown>): OpencodeCloneModel {
  const settings = isRecord(record.settings) ? record.settings : {};
  const cost = Array.isArray(record.cost) ? costFromRecord(record.cost[0]) : undefined;
  return withFields(modelId, {
    name: text(record.name),
    npm: text(record.package),
    endpoint: text(settings.baseURL),
    limit: limitFromRecord(record.limit),
    cost,
    variants: variantsFromRecord(record.variants),
  });
}

/** One 1.x `models --verbose` record: `api.npm`, `api.url`, `limit`, `cost`, `variants`. */
export function cloneFromV1Record(modelId: string, record: Record<string, unknown>): OpencodeCloneModel {
  const api = isRecord(record.api) ? record.api : {};
  return withFields(modelId, {
    name: text(record.name),
    npm: text(api.npm),
    endpoint: text(api.url),
    limit: limitFromRecord(record.limit),
    cost: costFromRecord(record.cost),
    variants: variantsFromRecord(record.variants),
  });
}

/** Keep `clone` for `provider` when the sink wants that provider's records. */
export function collectClone(sink: CloneSink | undefined, provider: string, clone: OpencodeCloneModel): void {
  if (!sink?.providers.has(provider)) return;
  const list = sink.models.get(provider);
  if (list) list.push(clone);
  else sink.models.set(provider, [clone]);
}
