import { useEffect } from "react"
import type { FallbackLink } from "@jinn/fallback-chain-wire"
import { ChainFlowDisclosure } from "@/components/fallback/chain-flow-disclosure"
import { resolveForFlow } from "@/components/fallback/resolve-links"
import { useModelRegistry } from "@/hooks/use-model-registry"
import { useFallbackChains } from "@/hooks/use-fallback-chains"
import type { Employee, EmployeeUpdate } from "@/lib/api"
import { engineDisplayName } from "@/lib/engine-names"
import { ChainEditor } from "@/routes/settings/engines/chain-editor"
import { LegacyNotice } from "@/routes/settings/engines/chain-body"
import { SettingsSelect } from "@/routes/settings/shared"
import { chainBlocked, employeeChainOf, employeeSubject, fallbackFieldState, sameChain, subjectProblems, type InheritedChain, type OwnChain } from "./employee-fallback"

export { employeeChainOf, sameChain }
export { refreshFallbackChains } from "@/hooks/use-fallback-chains"
/** What the editor adds to its PATCH. */
export type FallbackPatch = Pick<EmployeeUpdate, "fallback">

interface EmployeeFallbackFieldProps {
  employee: Employee
  /** The engine the employee runs on, as the editor now has it. */
  engine: string
  /** The employee's own chain; null inherits. */
  value: FallbackLink[] | null
  onChange: (next: FallbackLink[] | null) => void
  /** Told whether the chain holds a problem, so the editor can refuse to save it. */
  onBlockedChange?: (blocked: boolean) => void
}

/** The editor's labelled row for the chain, shaped like its other fields. A system employee's chain is the
 *  default's and cannot be set (the gateway refuses it), so it is shown, not offered. */
export function EmployeeFallbackRow({ locked, ...props }: EmployeeFallbackFieldProps & { locked?: boolean }) {
  return (
    <div className="flex flex-col gap-[var(--space-1)]" data-employee-fallback-row={locked ? "locked" : undefined}>
      {locked ? <EmployeeFallbackSummary employee={props.employee} /> : (
        <>
          <span className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
            Fallback chain
          </span>
          <EmployeeFallbackField {...props} />
          <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
            Where this employee&apos;s sessions go when its own target reaches a limit.
          </span>
        </>
      )}
    </div>
  )
}

/** Per link, where it came from: only a chain written in names has links that came from elsewhere. */
function originsOf(own: OwnChain | null): ("config" | "legacy")[] | undefined {
  return own?.expanded.map((expanded) => (expanded ? "legacy" : "config"))
}

const INHERIT = "inherit"
const CUSTOM = "custom"

/** Inherit or custom. Custom starts from the chain the default runs: until the gateway has said what that is it would start from nothing, which means no fallback at all, so it waits. */
function ChainChoice({ custom, ready, inherited, onChange }: {
  custom: boolean
  ready: boolean
  inherited: InheritedChain
  onChange: (next: FallbackLink[] | null) => void
}) {
  return (
    <SettingsSelect
      value={custom ? CUSTOM : INHERIT}
      ariaLabel="Fallback chain"
      onChange={(choice) => { if (choice !== CUSTOM) onChange(null); else if (ready) onChange(inherited.links) }}
      options={[
        { value: INHERIT, label: `Use the default (from ${inherited.label})` },
        { value: CUSTOM, label: "Custom", disabled: !ready },
      ]}
    />
  )
}

/** What the gateway itself says is wrong with a chain. */
function GatewayProblems({ problems }: { problems: string[] }) {
  return (
    <>
      {problems.map((problem) => (
        <p key={problem} data-chain-problem role="alert" className="m-0 text-[length:var(--text-caption2)]" style={{ color: "var(--system-red)" }}>
          {problem}
        </p>
      ))}
    </>
  )
}

/** "Use the default" or "Custom": the default's chain read-only, or the same rows an
 *  engine's chain has. Switching to Custom starts from the chain the default runs. */
export function EmployeeFallbackField({ employee, engine, value, onChange, onBlockedChange }: EmployeeFallbackFieldProps) {
  const { data: registry } = useModelRegistry()
  const { data: chains } = useFallbackChains(employee.name)
  const { inherited, self, shown, own, subject } = fallbackFieldState(employee, engine, value, chains)
  const blocked = chainBlocked(registry, own, self, chains)
  useEffect(() => { onBlockedChange?.(blocked) }, [blocked, onBlockedChange])
  if (!registry) return null

  return (
    <div className="flex flex-col gap-[var(--space-1)]" data-employee-fallback>
      <ChainChoice custom={own !== null} ready={Boolean(chains)} inherited={inherited} onChange={onChange} />
      {own === null ? (
        <InheritedRows links={inherited.links} engine={engine} />
      ) : (
        <>
          {own.legacy && <LegacyNotice />}
          <ChainEditor
            chainName={`${employee.displayName || employee.name} chain`}
            ownEngine={engine}
            self={self}
            where="fallback"
            links={own.links}
            expanded={own.expanded}
            fields={{ registry, profiles: chains?.profiles.map((p) => p.name) ?? [] }}
            waitsAs={engineDisplayName(engine)}
            onChange={onChange}
          />
        </>
      )}
      <GatewayProblems problems={subjectProblems(subject)} />
      {shown.length > 0 && <ChainFlowDisclosure links={resolveForFlow(self, shown, subject, originsOf(own))} />}
    </div>
  )
}

/** The default's chain as plain text: it is read here, and edited where it is written. */
function InheritedRows({ links, engine }: { links: FallbackLink[]; engine: string }) {
  if (links.length === 0) {
    return <p className="m-0 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">No fallback. {engineDisplayName(engine)} waits for its own limit to reset.</p>
  }
  return <FallbackList links={links} />
}

/** An ordered, read-only chain: the same words a row's label uses. */
export function FallbackList({ links }: { links: FallbackLink[] }) {
  return (
    <ol data-fallback-list className="m-0 flex list-none flex-col gap-[2px] p-0 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
      {links.map((link, i) => (
        <li key={i}>
          <span className="text-[var(--text-quaternary)] [font-variant-numeric:tabular-nums]">{i + 1}. </span>
          {[engineDisplayName(link.engine), link.profile, link.model].filter(Boolean).join(" · ")}
        </li>
      ))}
    </ol>
  )
}

/** On the employee's detail card: the chain that would run, read-only, and where it comes from. */
export function EmployeeFallbackSummary({ employee }: { employee: Employee }) {
  const { data: chains } = useFallbackChains(employee.name)
  const subject = employeeSubject(chains, employee.name)
  if (!subject || subject.effective.length === 0) return null
  const links = subject.effective.map((l) => ({ engine: l.engine, ...(l.profile ? { profile: l.profile } : {}), ...(l.model ? { model: l.model } : {}) }))
  const own = subject.configured !== null
  return (
    <div className="mt-[var(--space-4)]" data-employee-fallback-summary>
      <p className="mb-[var(--space-1)] text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
        Fallback chain <span className="font-normal normal-case tracking-normal text-[var(--text-quaternary)]">· {own ? "custom" : "the default"}</span>
      </p>
      <FallbackList links={links} />
      <ChainFlowDisclosure links={resolveForFlow(subject.primary ?? { engine: employee.engine }, links, subject)} />
    </div>
  )
}
