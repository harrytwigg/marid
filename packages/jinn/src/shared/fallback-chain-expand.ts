import { declaredClaudeAccounts } from "./claude-accounts-config.js";
import { DEFAULT_CLAUDE_ACCOUNT } from "./engine-account.js";
import { fallbackLinkKey, fallbackLinkOf, type FallbackChainEntry, type FallbackLink } from "./fallback-chain-wire.js";
import type { JinnConfig } from "./types.js";

/**
 * Legacy expansion: a chain as written, with each string entry replaced in place
 * by that target followed by its own chain, so that a chain written only in the
 * legacy strings visits targets in exactly the order the engine walker
 * (`resolveFallbackEngine`) and the account walker (`resolveAccountFallback`)
 * did. An object entry is one target and expands to nothing more.
 *
 * Two walks, as there were two walkers:
 * - `account`: a local Claude session. Targets are told apart by account, so
 *   `claude` and `claude:<name>` are different targets, and every string entry
 *   (including an account entry) expands to that account's own chain.
 * - `engine`: any other session, remote ones included. Targets are told apart
 *   by engine, and the account entries inside an expanded chain are dropped, as
 *   the engine walker filtered them.
 *
 * Pure: config alone. Whether a target is installed, healthy or allowed for a
 * session is the resolver's question (fallback-chain.ts), not this one's.
 */

export type FallbackExpansionMode = "account" | "engine";

/** One target of the effective chain, and where it came from. */
export interface ExpandedFallbackLink {
  link: FallbackLink;
  /** "config" for an entry of the chain as written; "legacy" for one pulled in by a string entry's own chain. */
  origin: "config" | "legacy";
}

export interface ExpandFallbackOptions {
  mode: FallbackExpansionMode;
  /** The subject's own identity in the mode's terms: its account key (`account`) or its engine (`engine`). Never an answer. */
  selfAccount: string;
  /** The exact key of the subject's own target, when it has one: a link equal to it is never an answer either. */
  selfKey?: string;
}

type Queued = { entry: FallbackChainEntry; origin: ExpandedFallbackLink["origin"] };

type EngineSection = { fallback?: FallbackChainEntry[] } | undefined;

function engineChain(config: JinnConfig, engine: string): FallbackChainEntry[] {
  return (config.engines as unknown as Record<string, EngineSection>)[engine]?.fallback ?? [];
}

/** The identity a legacy walker told targets apart by; undefined for an account entry naming no declared account. */
function identityOf(config: JinnConfig, mode: FallbackExpansionMode, link: FallbackLink): string | undefined {
  if (link.engine !== "claude") return link.engine;
  if (link.profile === undefined) return DEFAULT_CLAUDE_ACCOUNT;
  if (mode === "engine") return `${DEFAULT_CLAUDE_ACCOUNT}:${link.profile}`;
  return declaredClaudeAccounts(config).find((account) => account.name === link.profile)?.key;
}

/** The chain a string entry's target brings with it. */
function ownChainOf(config: JinnConfig, mode: FallbackExpansionMode, link: FallbackLink, identity: string): FallbackChainEntry[] {
  if (mode === "account") {
    if (link.profile === undefined) return engineChain(config, link.engine);
    return declaredClaudeAccounts(config).find((account) => account.key === identity)?.fallback ?? [];
  }
  if (link.profile !== undefined) return [];
  return engineChain(config, link.engine).filter((entry) => !(typeof entry === "string" && entry.startsWith(`${DEFAULT_CLAUDE_ACCOUNT}:`)));
}

/**
 * The effective chain: `entries` expanded breadth-first, each target once. A
 * string entry is skipped when its account or engine was already visited (the
 * subject's own included); any entry is skipped when its exact target is
 * already listed. A chain in the legacy strings alone therefore comes out as
 * the order the old walkers visited, cycles included.
 */
export function expandFallbackChain(config: JinnConfig, entries: readonly FallbackChainEntry[], options: ExpandFallbackOptions): ExpandedFallbackLink[] {
  const { mode } = options;
  const visited = new Set<string>([options.selfAccount]);
  const listed = new Set<string>(options.selfKey === undefined ? [] : [options.selfKey]);
  const queue: Queued[] = entries.map((entry) => ({ entry, origin: "config" }));
  const out: ExpandedFallbackLink[] = [];

  for (let i = 0; i < queue.length; i++) {
    const { entry, origin } = queue[i];
    const link = fallbackLinkOf(entry);
    if (!link) continue;
    const legacy = typeof entry === "string";
    const identity = identityOf(config, mode, link);
    if (legacy && (identity === undefined || visited.has(identity))) continue;
    const key = fallbackLinkKey(link);
    if (listed.has(key)) continue;
    listed.add(key);
    out.push({ link, origin });
    if (!legacy || identity === undefined) continue;
    visited.add(identity);
    queue.push(...ownChainOf(config, mode, link, identity).map((next): Queued => ({ entry: next, origin: "legacy" })));
  }
  return out;
}
