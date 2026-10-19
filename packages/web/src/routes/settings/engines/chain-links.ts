import {
  fallbackLinkKey,
  type FallbackChainEntry,
  fallbackLinkOf,
  type FallbackLink,
  type ResolvedFallbackLink,
} from "@jinn/fallback-chain-wire"
import { engineDisplayName } from "@/lib/engine-names"

/* The chain editor's model: a chain is a list of object links, however config
 * spells it. Every function returns a new list and leaves its argument alone. */

/** What a link's engine select and model picker are drawn from, per engine. */
export interface EngineChoice {
  name: string
  available: boolean
  defaultModel: string
  models: { id: string; label: string }[]
}

/** The instance as a row needs to know it. */
export interface ChainContext {
  engines: EngineChoice[]
  /** Declared account names under `engines.claude.accounts`. */
  profiles: string[]
}

/** Each entry as a link; an entry that is neither form is dropped. */
export function linksOfEntries(entries: readonly unknown[] | undefined): FallbackLink[] {
  return (entries ?? []).flatMap((entry) => fallbackLinkOf(entry) ?? [])
}

/** True when any entry is a string, whose own chain expands at run time. */
export function hasLegacyEntries(entries: readonly unknown[] | undefined): boolean {
  return (entries ?? []).some((entry) => typeof entry === "string")
}

/** A resolved link as config holds it: the gateway's `written` form, never the model it
 *  filled in to run (writing that back would pin a model the operator did not choose). */
export function linkOfResolved(resolved: FallbackLink & { written?: FallbackLink }): FallbackLink {
  const { engine, profile, model } = resolved.written ?? resolved
  return { engine, ...(profile ? { profile } : {}), ...(model ? { model } : {}) }
}

export interface ShownChain {
  links: FallbackLink[]
  /** Per row: "legacy" for a link expanded from another entry's own chain. */
  origins: ("config" | "legacy")[]
  /** The chain is written in string entries, so `links` is its expansion. */
  legacy: boolean
}

/**
 * The chain as the editor shows it. A chain written in object links is shown as
 * written. One with string entries is shown as the gateway expands it (`effective`),
 * because that is what runs; until the gateway has answered, as its entries read.
 */
export function shownChain(entries: readonly unknown[] | undefined, effective: ResolvedFallbackLink[] | undefined): ShownChain {
  const legacy = hasLegacyEntries(entries)
  if (legacy && effective) {
    return { links: effective.map(linkOfResolved), origins: effective.map((l) => l.origin), legacy }
  }
  const links = linksOfEntries(entries)
  return { links, origins: links.map(() => "config" as const), legacy }
}

export function removeLink(links: FallbackLink[], index: number): FallbackLink[] {
  return links.filter((_, i) => i !== index)
}

/** Move one link, keeping every other link's relative order. An index outside the
 *  chain returns it unchanged rather than dropping or duplicating a link. */
export function moveLink(links: FallbackLink[], from: number, to: number): FallbackLink[] {
  if (from === to) return links
  if (from < 0 || from >= links.length || to < 0 || to >= links.length) return links
  const next = [...links]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function replaceLink(links: FallbackLink[], index: number, link: FallbackLink): FallbackLink[] {
  return links.map((existing, i) => (i === index ? link : existing))
}

/** A new engine for a row. A model belongs to one engine, and only Claude takes a
 *  profile, so both start over rather than carry a value the new engine refuses. */
export function withEngine(_link: FallbackLink, engine: string): FallbackLink {
  return { engine }
}

/** A profile for a Claude row; "" is the default profile and writes none. */
export function withProfile(link: FallbackLink, profile: string): FallbackLink {
  const { profile: _old, ...rest } = link
  return profile ? { ...rest, profile } : rest
}

/** A model for a row; "" is "no model" and writes none. */
export function withModel(link: FallbackLink, model: string): FallbackLink {
  const { model: _old, ...rest } = link
  return model ? { ...rest, model } : rest
}

/** Only a Claude link takes a profile: "Default profile" plus the declared accounts. */
export function profileOptionsFor(engine: string, profiles: string[]): { value: string; label: string }[] | null {
  if (engine !== "claude") return null
  return [{ value: "", label: "Default profile" }, ...profiles.map((name) => ({ value: name, label: name }))]
}

/**
 * What a row with no model means, in words. On the chain's own engine it runs the
 * session's own model; on another it is the model map's translation, else that
 * engine's default. Both write no model, so the row shows the one that is true.
 */
export function noModelLabel(engine: string, ownEngine: string | undefined): string {
  return engine === ownEngine ? "Same model" : "Engine default"
}

/** A link as a row names it: "Claude · work · sonnet". */
export function rowLabel(link: FallbackLink): string {
  return [engineDisplayName(link.engine), link.profile, link.model].filter(Boolean).join(" · ")
}

/**
 * The link a new row starts as: the first installed engine whose bare link the
 * chain does not already hold and that is not `self`, else the first engine that
 * is not `self`. The latter is a duplicate, which the row says so the operator
 * changes it.
 */
export function blankLink(ctx: ChainContext, links: FallbackLink[], self: FallbackLink | undefined): FallbackLink {
  const taken = new Set(links.map(fallbackLinkKey))
  if (self) taken.add(fallbackLinkKey(self))
  const names = ctx.engines.map((e) => e.name)
  const installed = ctx.engines.filter((e) => e.available).map((e) => e.name)
  const free = installed.find((name) => !taken.has(fallbackLinkKey({ engine: name })))
  return { engine: free ?? names.find((name) => name !== self?.engine) ?? names[0] ?? "claude" }
}

/**
 * The chain as it is written back. A link whose entry the operator did not touch
 * goes back as that very entry, so nothing about it changes — its fields, its
 * spelling — and an object entry is never turned into a string. Every other link
 * is a plain object link, which is also how a legacy chain's expansion is saved.
 */
export function writeLinks(entries: readonly FallbackChainEntry[] | undefined, links: FallbackLink[]): FallbackChainEntry[] {
  const untouched = (entries ?? []).filter((entry): entry is FallbackLink => typeof entry === "object" && entry !== null)
  return links.map((link) => {
    const key = fallbackLinkKey(link)
    const at = untouched.findIndex((entry) => {
      const known = fallbackLinkOf(entry)
      return known !== null && fallbackLinkKey(known) === key
    })
    return at === -1 ? link : untouched.splice(at, 1)[0]
  })
}
