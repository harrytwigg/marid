/**
 * What `engines.opencode.accounts` means once opencode's catalogue is known
 * (docs/design/opencode-accounts.md): the models an account serves, the
 * `provider` block staged for it, and the problems with it that the load-time
 * checks (`opencode-accounts-config.ts`) cannot see.
 *
 * Pure, with no I/O: the catalogue, the clone records and the environment are
 * handed in, so the gateway, `hundredfold doctor` and the web editor read the same
 * answer.
 */
import type { ModelInfo } from "./types.js";
import type { OpencodeCloneCost, OpencodeCloneModel, OpencodeClones } from "./opencode-clone.js";
import { declaredOpencodeAccounts, stagedOpencodeAccounts, type OpencodeAccount } from "./opencode-accounts-config.js";
import { opencodeLinkProblems, type FallbackChainEntry, type FallbackLink, type FallbackOpencodeContext, fallbackLinkOf } from "./fallback-chain-wire.js";

type AccountsConfig = Parameters<typeof declaredOpencodeAccounts>[0];

/** Which opencode CLI generation a config is staged for. */
export type OpencodeStageApi = 1 | 2;

/** One model of a staged `provider` block, in opencode's config shape. */
export interface OpencodeProviderModel {
  name?: string;
  limit?: { context?: number; input?: number; output?: number };
  cost?: OpencodeCloneCost;
  variants?: Record<string, Record<string, unknown>>;
  /** A model served from another SDK or endpoint than the block's own. */
  provider?: { npm?: string; api?: string };
}

/** One account's `provider` block, as written into the config opencode reads. */
export interface OpencodeProviderBlock {
  name: string;
  npm?: string;
  options: { baseURL?: string; apiKey: string };
  models: Record<string, OpencodeProviderModel>;
}

/** A provider block and the models it had to leave out. */
export interface PlannedProvider {
  block: OpencodeProviderBlock;
  /** Model ids left out because this CLI cannot reach their endpoint (1.x only). */
  dropped: string[];
}

/** `@opencode/ai/providers/<sdk>` (OpenCode 2's own package names) as `@ai-sdk/<sdk>`, the form a config takes. Any other name is left alone. */
export function configNpmName(npm: string): string {
  const match = /^@opencode\/ai\/providers\/(.+)$/.exec(npm);
  return match ? `@ai-sdk/${match[1]}` : npm;
}

/** The environment reference a staged block carries instead of a key. */
export function keyEnvReference(keyEnv: string): string {
  return `{env:${keyEnv}}`;
}

const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible";

function mostCommon<T>(values: readonly T[], tieBreak: (a: T, b: T) => number): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || tieBreak(a[0], b[0]))[0]?.[0];
}

/** The endpoint most of `models` are served from; on a tie, the one that serves an openai-compatible model, then the first by name. `undefined` when no model names an endpoint. */
export function mainEndpoint(models: readonly OpencodeCloneModel[]): string | undefined {
  const withEndpoint = models.filter((m) => m.endpoint !== undefined);
  const compatible = new Set(withEndpoint.filter((m) => m.npm !== undefined && configNpmName(m.npm) === OPENAI_COMPATIBLE).map((m) => m.endpoint));
  return mostCommon(
    withEndpoint.map((m) => m.endpoint!),
    (a, b) => Number(compatible.has(b)) - Number(compatible.has(a)) || (a < b ? -1 : a > b ? 1 : 0),
  );
}

/** The SDK the block itself names: openai-compatible when a model on the main endpoint uses it, else the most used one there. */
function mainNpm(models: readonly OpencodeCloneModel[], endpoint: string | undefined): string | undefined {
  const onMain = models.filter((m) => m.endpoint === endpoint && m.npm !== undefined).map((m) => configNpmName(m.npm!));
  if (onMain.includes(OPENAI_COMPATIBLE)) return OPENAI_COMPATIBLE;
  return mostCommon(onMain, (a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The per-model `provider: {npm, api}` for a model served from another SDK or endpoint than the block's own, or none. */
function providerOverride(model: OpencodeCloneModel, endpoint: string | undefined, npm: string | undefined): OpencodeProviderModel["provider"] {
  const ownNpm = model.npm === undefined ? undefined : configNpmName(model.npm);
  const elsewhere = model.endpoint !== endpoint || ownNpm !== npm;
  if (!elsewhere || (ownNpm === undefined && model.endpoint === undefined)) return undefined;
  return { ...(ownNpm === undefined ? {} : { npm: ownNpm }), ...(model.endpoint === undefined ? {} : { api: model.endpoint }) };
}

function providerModel(model: OpencodeCloneModel, endpoint: string | undefined, npm: string | undefined): OpencodeProviderModel {
  const override = providerOverride(model, endpoint, npm);
  return {
    ...(model.name === undefined ? {} : { name: model.name }),
    ...(model.limit ? { limit: { ...model.limit } } : {}),
    ...(model.cost ? { cost: { ...model.cost } } : {}),
    ...(model.variants ? { variants: structuredClone(model.variants) } : {}),
    ...(override ? { provider: override } : {}),
  };
}

/**
 * The `provider` block for one account (the design's "Staging"). The block
 * names the main endpoint and SDK; a model on another SDK or endpoint carries a
 * per-model `provider: {npm, api}`. OpenCode 1.x honours a per-model SDK but
 * sends every model to the block's own endpoint, so on `api` 1 a model whose
 * endpoint differs is left out (and returned in `dropped`). The key appears
 * only as an environment reference.
 */
export function planAccountProvider(account: OpencodeAccount, models: readonly OpencodeCloneModel[], api: OpencodeStageApi): PlannedProvider {
  const endpoint = mainEndpoint(models);
  const npm = mainNpm(models, endpoint);
  const kept = api === 1 ? models.filter((m) => m.endpoint === endpoint) : models;
  const dropped = api === 1 ? models.filter((m) => m.endpoint !== endpoint).map((m) => m.id) : [];
  const block: OpencodeProviderBlock = {
    name: account.label,
    ...(npm === undefined ? {} : { npm }),
    options: { ...(endpoint === undefined ? {} : { baseURL: endpoint }), apiKey: keyEnvReference(account.keyEnv ?? "") },
    models: Object.fromEntries(kept.map((m) => [m.id, providerModel(m, endpoint, npm)])),
  };
  return { block, dropped };
}

/** The base provider's models, cut to `account.models` when it names a subset. Order is the base's. */
export function accountCloneModels(account: OpencodeAccount, clones: OpencodeClones): OpencodeCloneModel[] {
  if (account.base === undefined) return [];
  const wanted = account.models === undefined ? undefined : new Set(account.models);
  return (clones.get(account.base) ?? []).filter((m) => wanted === undefined || wanted.has(m.id));
}

/** Every `provider/model` of one base provider in `catalogue`, as its model ids without the provider. */
function baseModelInfos(catalogue: readonly ModelInfo[], base: string): ModelInfo[] {
  return catalogue.filter((m) => m.id.startsWith(`${base}/`));
}

/** The registry entries of one account: its base's models (cut to `models`) as `<provider>/<model>`, each with the base's label, window and effort levels and `account` set. */
export function accountModelInfos(account: OpencodeAccount, catalogue: readonly ModelInfo[]): ModelInfo[] {
  if (account.base === undefined) return [];
  const wanted = account.models === undefined ? undefined : new Set(account.models);
  const prefix = `${account.base}/`;
  return baseModelInfos(catalogue, account.base)
    .filter((m) => wanted === undefined || wanted.has(m.id.slice(prefix.length)))
    .map((m) => ({ ...m, id: `${account.provider}/${m.id.slice(prefix.length)}`, effortLevels: [...m.effortLevels], account: account.name }));
}

/** The ids (without the provider) of the account's models a 1.x binary cannot serve: those off the main endpoint, which 1.x would send to the block's own. None while the base's endpoints are not known. */
export function accountOffEndpointModels(account: OpencodeAccount, clones: OpencodeClones): string[] {
  return planAccountProvider(account, accountCloneModels(account, clones), 1).dropped;
}

/** What decides which account models the registry lists. */
export interface AccountRegistryInputs {
  /** The local opencode binary's API. On 1, the models it cannot serve are left out; unknown (undefined) or 2 lists every one. */
  localApi?: OpencodeStageApi;
  clones?: OpencodeClones;
}

/** Every account model the config's accounts add to `catalogue`, to be listed beside it, less (on a local 1.x binary) the models it cannot serve, so chains skip them and pickers do not offer them. */
export function accountRegistryModels(config: AccountsConfig, catalogue: readonly ModelInfo[], inputs: AccountRegistryInputs = {}): ModelInfo[] {
  return stagedOpencodeAccounts(config).flatMap((account) => {
    const infos = accountModelInfos(account, catalogue);
    if (inputs.localApi !== 1 || inputs.clones === undefined) return infos;
    const left = new Set(accountOffEndpointModels(account, inputs.clones).map((model) => `${account.provider}/${model}`));
    return infos.filter((info) => !left.has(info.id));
  });
}

/** The error of a turn whose own model the host's opencode generation cannot serve. */
export function unservedModelError(model: string, account: string): string {
  return `${model} is not served by account "${account}" on OpenCode 1.x (models on another endpoint need OpenCode 2)`;
}

/** What the problem checks read of the host. */
export interface AccountProblemInputs {
  /** opencode's catalogue on this host, before account models are added. Null: not known yet. */
  catalogue: readonly ModelInfo[] | null;
  clones: OpencodeClones;
  /** The gateway's environment, to see whether each `keyEnv` is set. */
  env: Readonly<Record<string, string | undefined>>;
  /** The local binary's API, for the models a 1.x one cannot reach. */
  localApi?: OpencodeStageApi;
}

/** Whether a key variable holds a usable value. */
export function keyEnvIsSet(env: Readonly<Record<string, string | undefined>>, keyEnv: string | undefined): boolean {
  return keyEnv !== undefined && (env[keyEnv] ?? "").trim() !== "";
}

function catalogueProblems(account: OpencodeAccount, catalogue: readonly ModelInfo[]): string[] {
  const where = `account "${account.name}"`;
  const base = account.base!;
  const baseModels = baseModelInfos(catalogue, base).map((m) => m.id.slice(base.length + 1));
  const problems: string[] = [];
  if (baseModels.length === 0) problems.push(`${where}: base "${base}" is not in opencode's catalogue on this host`);
  if (catalogue.some((m) => m.id.startsWith(`${account.provider}/`))) {
    problems.push(`${where}: provider "${account.provider}" is already a provider in opencode's catalogue; pick an id no provider uses`);
  }
  if (baseModels.length > 0) {
    for (const model of account.models ?? []) {
      if (!baseModels.includes(model)) problems.push(`${where}: model "${model}" is not one of base "${base}"'s models`);
    }
  }
  return problems;
}

/** The account's base has models in the catalogue but no endpoint records were kept for them: the staged block would be empty. */
export function accountUnstaged(account: OpencodeAccount, catalogue: readonly ModelInfo[], clones: OpencodeClones): boolean {
  return account.base !== undefined && accountModelInfos(account, catalogue).length > 0 && accountCloneModels(account, clones).length === 0;
}

/** The sentence for {@link accountUnstaged}. */
function unstagedProblem(account: OpencodeAccount): string {
  return `account "${account.name}": the base's endpoints are not known yet (model details have not loaded), so its models cannot be served`;
}

function droppedProblems(account: OpencodeAccount, inputs: AccountProblemInputs): string[] {
  if (inputs.localApi !== 1) return [];
  const dropped = accountOffEndpointModels(account, inputs.clones);
  return dropped.length === 0 ? []
    : [`account "${account.name}": the local opencode is 1.x, which sends every model to one endpoint; left out of the model list on this host, and a turn on one fails: ${dropped.join(", ")}`];
}

/**
 * The problems with the declared accounts that need the catalogue or the
 * environment (the design's "Catalogue cloning" and "Staging"): a base missing
 * from the catalogue, a provider id that collides with one in it, a model that is
 * not the base's, a key variable that is not set, and models a 1.x local binary
 * cannot reach. The checks that need the catalogue are skipped while it is not
 * known (`catalogue` null) rather than blaming every account for it.
 */
export function opencodeAccountProblems(config: AccountsConfig, inputs: AccountProblemInputs): string[] {
  return stagedOpencodeAccounts(config).flatMap((account) => oneAccountProblems(account, inputs));
}

/** {@link opencodeAccountProblems} for one account: what `hundredfold doctor` and `GET /api/engine-limits` say of it. */
export function oneAccountProblems(account: OpencodeAccount, inputs: AccountProblemInputs): string[] {
  if (account.base === undefined) return [];
  return [
    ...(inputs.catalogue === null || inputs.catalogue.length === 0 ? [] : catalogueProblems(account, inputs.catalogue)),
    ...(inputs.catalogue !== null && accountUnstaged(account, inputs.catalogue, inputs.clones) ? [unstagedProblem(account)] : []),
    ...(keyEnvIsSet(inputs.env, account.keyEnv) ? [] : [`account "${account.name}" has no key: ${account.keyEnv} is not set`]),
    ...(inputs.catalogue === null || inputs.catalogue.length === 0 ? [] : droppedProblems(account, inputs)),
  ];
}

/**
 * What chain validation knows of opencode: every declared account (a built-in
 * provider's models are the catalogue's own, so only a based account lists them),
 * and the catalogue's providers. `env` is the gateway's environment, given only
 * where one exists (the web has none, so it never reports a missing key).
 */
export function opencodeChainContext(
  config: AccountsConfig,
  catalogue: readonly ModelInfo[] | null,
  env?: Readonly<Record<string, string | undefined>>,
  clones?: OpencodeClones,
): FallbackOpencodeContext {
  const known = catalogue !== null && catalogue.length > 0;
  return {
    accounts: declaredOpencodeAccounts(config).map((account) => ({
      name: account.name,
      provider: account.provider,
      ...(known && account.base !== undefined ? { models: accountModelInfos(account, catalogue).map((m) => m.id.slice(account.provider.length + 1)) } : {}),
      ...(account.keyEnv === undefined ? {} : { keyEnv: account.keyEnv }),
      ...(known && clones !== undefined && accountUnstaged(account, catalogue, clones) ? { unstaged: true } : {}),
      ...(env !== undefined && account.keyEnv !== undefined && !keyEnvIsSet(env, account.keyEnv) ? { keyMissing: true } : {}),
    })),
    ...(known ? { providers: new Set(catalogue.map((m) => m.id.slice(0, m.id.indexOf("/")))) } : {}),
  };
}

/** The opencode-specific problems of one written chain, in the wire module's words (and none of its other problems). */
export function opencodeChainProblems(where: string, chain: readonly FallbackChainEntry[] | undefined, opencode: FallbackOpencodeContext): string[] {
  return (chain ?? []).flatMap((entry, index) => {
    const link: FallbackLink | null = fallbackLinkOf(entry);
    return link ? opencodeLinkProblems(`${where}[${index}]`, link, opencode) : [];
  });
}
