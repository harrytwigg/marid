import type { FallbackChainEntry, FallbackChainSubject, FallbackLink } from "@jinn/fallback-chain-wire"
import { ChainFlowDisclosure } from "@/components/fallback/chain-flow-disclosure"
import { resolveForFlow } from "@/components/fallback/resolve-links"
import { subjectProblems } from "@/hooks/use-fallback-chains"
import { ChainEditor } from "./chain-editor"
import { shownChain } from "./chain-links"
import type { RowFields } from "./chain-row"

export interface ChainBodyProps {
  /** The chain as config states it. */
  entries: FallbackChainEntry[]
  /** What the gateway says of this chain; absent until it has answered. */
  subject: FallbackChainSubject | undefined
  /** The gateway's chains could not be read. */
  chainsFailed?: boolean
  chainName: string
  ownEngine: string
  self: FallbackLink
  /** The config key, for the validator's sentences. */
  where: string
  waitsAs: string
  fields: Omit<RowFields, "chainName" | "ownEngine">
  onChange: (links: FallbackLink[]) => void
}

/** A chain written in engine names runs as its expansion; say so once, so the
 *  rows are not mistaken for what is in the file. */
export function LegacyNotice() {
  return (
    <p data-chain-legacy-notice className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
      Written as engine names, shown as it runs. The first edit saves it as explicit links.
    </p>
  )
}

/** One subject's chain: the notice when it is legacy, the editor, then the diagram. */
export function ChainBody(props: ChainBodyProps) {
  const shown = shownChain(props.entries, props.subject?.effective)
  // A chain written in engine names is edited as it runs, which only the gateway can say: an edit
  // before its answer would save the bare names' links and drop what they expand to.
  if (shown.legacy && !props.subject) {
    return props.chainsFailed
      ? <p data-chain-unreadable role="alert" className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]">The gateway could not say how this chain runs, so it can't be edited here. Reload to try again.</p>
      : <p data-chain-loading className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Loading the chain as it runs…</p>
  }
  return (
    <>
      {shown.legacy && <LegacyNotice />}
      <ChainEditor
        chainName={props.chainName}
        ownEngine={props.ownEngine}
        self={props.self}
        where={props.where}
        links={shown.links}
        expanded={shown.origins.map((origin) => origin === "legacy")}
        fields={props.fields}
        waitsAs={props.waitsAs}
        serverProblems={subjectProblems(props.subject)}
        onChange={props.onChange}
      />
      {shown.links.length > 0 && (
        <ChainFlowDisclosure links={resolveForFlow(props.self, shown.links, props.subject, shown.origins)} />
      )}
    </>
  )
}
