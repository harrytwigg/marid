import { useModelRegistry } from "@/hooks/use-model-registry"
import { findSubject, useFallbackChains } from "@/hooks/use-fallback-chains"
import { Section } from "../shared"
import { AccountCard, EngineCard, RemoteAccountCard } from "./engine-card"
import { LegacyFallbackRow } from "./legacy-row"
import type { ChainBodyProps } from "./chain-body"
import {
  accountEntriesFor,
  accountNames,
  allAccountNames,
  chainEntriesFor,
  legacyFallbackEngine,
  legacyMigrationMutations,
  modelMapFor,
  remoteAccounts,
  substituteChainFor,
  type EnginesConfig,
  type SessionsFallbackConfig,
} from "./chain-model"
import { linksOfEntries, writeLinks } from "./chain-links"
import { chainNameOf } from "./chain-editor"
import { mapConfigValue, type ServedModels } from "./model-map-model"
import type { EnginesResponse } from "@/lib/api"
import type { FallbackChainsResponse } from "@jinn/fallback-chain-wire"

interface EnginesSectionProps {
  engines: EnginesConfig | undefined
  sessions: SessionsFallbackConfig | undefined
  /** The Settings page's config setter; each call schedules the PUT. */
  onChange: (path: string[], value: unknown) => void
}

interface SectionContext {
  engines: EnginesConfig | undefined
  registry: EnginesResponse
  chains: FallbackChainsResponse | undefined
  chainsFailed: boolean
  onChange: EnginesSectionProps["onChange"]
}

function bodyForEngine(name: string, ctx: SectionContext): ChainBodyProps {
  return {
    entries: chainEntriesFor(ctx.engines, name),
    subject: findSubject(ctx.chains?.subjects, "engine", name),
    chainsFailed: ctx.chainsFailed,
    chainName: chainNameOf(name),
    ownEngine: name,
    self: { engine: name },
    where: `engines.${name}.fallback`,
    waitsAs: name === "claude" ? "Claude" : chainNameOf(name).replace(/ chain$/, ""),
    fields: { registry: ctx.registry, profiles: accountNames(ctx.engines), knownProfiles: allAccountNames(ctx.engines) },
    onChange: (links) => ctx.onChange(["engines", name, "fallback"], writeLinks(chainEntriesFor(ctx.engines, name), links)),
  }
}

function bodyForAccount(account: string, ctx: SectionContext): ChainBodyProps {
  return {
    entries: accountEntriesFor(ctx.engines, account),
    subject: findSubject(ctx.chains?.subjects, "account", account),
    chainsFailed: ctx.chainsFailed,
    chainName: chainNameOf("claude", account),
    ownEngine: "claude",
    self: { engine: "claude", profile: account },
    where: `engines.claude.accounts.${account}.fallback`,
    waitsAs: `Claude · ${account}`,
    fields: { registry: ctx.registry, profiles: accountNames(ctx.engines), knownProfiles: allAccountNames(ctx.engines) },
    onChange: (links) => ctx.onChange(["engines", "claude", "accounts", account, "fallback"], writeLinks(accountEntriesFor(ctx.engines, account), links)),
  }
}

function mapFor(name: string, ctx: SectionContext) {
  const entries = Object.values(ctx.registry.engines)
  const served: ServedModels = Object.fromEntries(entries.map((e) => [e.name, e.models.map((m) => m.id)]))
  const links = linksOfEntries(chainEntriesFor(ctx.engines, name))
  return {
    substitutes: substituteChainFor(ctx.engines, name),
    everyLinkNamesModel: links.length > 0 && links.every((link) => link.model !== undefined),
    pairs: modelMapFor(ctx.engines, name),
    served,
    defaultModels: Object.fromEntries(entries.map((e) => [e.name, e.defaultModel])),
    onChange: (pairs: [string, string][]) => ctx.onChange(["engines", name, "fallbackModelMap"], mapConfigValue(pairs)),
  }
}

/** Every engine the gateway knows, healthy or not, with the chain its turns fall
 *  through to, and under Claude one card for each declared account. Uninstalled
 *  engines are listed rather than hidden: an operator deciding what to fall back
 *  to needs to see the one that is not there yet. */
export function EnginesSection({ engines, sessions, onChange }: EnginesSectionProps) {
  const { data: registry } = useModelRegistry()
  if (!registry || Object.keys(registry.engines ?? {}).length === 0) return null
  return <EnginesBody engines={engines} sessions={sessions} onChange={onChange} registry={registry} />
}

/** The section once the registry is known: reads the gateway's view of the chains beside it. */
function EnginesBody({ engines, sessions, onChange, registry }: EnginesSectionProps & { registry: EnginesResponse }) {
  const { data: chains, isError: chainsFailed } = useFallbackChains()
  const ctx: SectionContext = { engines, registry, chains, chainsFailed, onChange }
  const legacy = legacyFallbackEngine(sessions)

  return (
    <Section title="Engine Fallbacks">
      <div className="flex flex-col gap-[var(--space-2)]">
        {Object.values(registry.engines).map((entry) => (
          <div key={entry.name} className="flex flex-col gap-[var(--space-2)]">
            <EngineCard entry={entry} body={bodyForEngine(entry.name, ctx)} map={mapFor(entry.name, ctx)} />
            {entry.name === "claude" && allAccountNames(engines).map((account) => {
              const remote = remoteAccounts(engines).find((r) => r.name === account)
              return remote
                ? <RemoteAccountCard key={account} account={remote} />
                : <AccountCard key={account} name={account} body={bodyForAccount(account, ctx)} />
            })}
          </div>
        ))}
        {legacy && (
          <LegacyFallbackRow
            engine={legacy}
            onMigrate={() => {
              for (const mutation of legacyMigrationMutations(legacy)) onChange(mutation.path, mutation.value)
            }}
          />
        )}
      </div>
    </Section>
  )
}
