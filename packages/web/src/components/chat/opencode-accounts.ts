import type { EngineRegistryEntry, EngineLimitsResponse, EnginesResponse, ModelInfo } from '@/lib/api'
import { providerOf } from '@/hooks/use-model-registry'

/** A declared opencode account (`engines.opencode.accounts`) as the chat pickers offer it. */
export interface OpencodeAccountChoice {
  /** The account's name: the key it is declared under. */
  name: string
  /** What the pickers call it: its configured label, else its name. */
  label: string
  /** The provider id its models are staged under: `opencode-go` for a built-in account, the alias for a clone. */
  provider: string
}

/** The declared accounts out of `GET /api/engine-limits`. None (an absent block, an older gateway) leaves every picker as it was. */
export function opencodeAccountChoices(limits: EngineLimitsResponse | undefined): OpencodeAccountChoice[] {
  const rows = limits?.accounts?.opencode
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    if (typeof row.account !== 'string' || typeof row.provider !== 'string' || !row.provider) return []
    return [{ name: row.account, label: typeof row.label === 'string' && row.label ? row.label : row.account, provider: row.provider }]
  })
}

/** The account a model id is served through, by its provider segment: `opencode-go/x` and `opencode-go-b/x` are different accounts. */
export function accountOfModelId(modelId: string, accounts: readonly OpencodeAccountChoice[]): OpencodeAccountChoice | undefined {
  const provider = providerOf(modelId)
  return provider ? accounts.find((a) => a.provider === provider) : undefined
}

/** The models of one account, or (`account` undefined) those no declared account serves. */
export function modelsOfAccount(models: readonly ModelInfo[], accounts: readonly OpencodeAccountChoice[], account: string | undefined): ModelInfo[] {
  return models.filter((m) => accountOfModelId(m.id, accounts)?.name === account)
}

/** The model a pick of `account` starts on: the engine's default when that account serves it, else its first featured model, else its first. */
export function defaultModelOfAccount(entry: EngineRegistryEntry | undefined, accounts: readonly OpencodeAccountChoice[], account: string | undefined): string | undefined {
  const own = modelsOfAccount(entry?.models ?? [], accounts, account)
  return own.find((m) => m.id === entry?.defaultModel)?.id ?? own.find((m) => m.featured)?.id ?? own[0]?.id
}

/**
 * The account the opencode panels are showing: the one just browsed to (for the model it was browsed from),
 * else the one the current model is served through. `undefined` is "the models no declared account serves",
 * which a registry that has none never shows: then it falls to the first account.
 */
export function shownAccountName(opts: {
  models: readonly ModelInfo[]
  accounts: readonly OpencodeAccountChoice[]
  modelId: string
  browsed: { forModel: string; account: string | undefined } | null
}): string | undefined {
  const { models, accounts, modelId, browsed } = opts
  const own = browsed && browsed.forModel === modelId ? browsed.account : accountOfModelId(modelId, accounts)?.name
  if (own !== undefined || modelsOfAccount(models, accounts, undefined).length > 0) return own
  return accounts[0]?.name
}

/** Whether the registry has an installed opencode: the only case the accounts are worth reading. */
export function opencodeAvailable(registry: EnginesResponse | undefined): boolean {
  return registry?.engines?.opencode?.available === true
}

/** The selection for picking an account's row: opencode, on that account's default model (the engine's own default if the account lists none). */
export function accountSelection(
  registry: EnginesResponse,
  accounts: readonly OpencodeAccountChoice[],
  account: string | undefined,
  effortLevelsFor: (model: string | undefined) => string[],
  defaultEffort: (levels: string[]) => string | undefined,
): { engine: 'opencode'; model: string | undefined; effortLevel: string | undefined } {
  const model = defaultModelOfAccount(registry.engines.opencode, accounts, account) ?? registry.engines.opencode?.defaultModel
  return { engine: 'opencode', model, effortLevel: defaultEffort(effortLevelsFor(model)) }
}

/** What an account's models are listed under: its label, or the models no declared account serves. */
export function accountListLabel(accounts: readonly OpencodeAccountChoice[], account: string | undefined): string {
  return accounts.find((a) => a.name === account)?.label ?? 'Other providers'
}
