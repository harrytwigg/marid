import type { FallbackLink } from "@jinn/fallback-chain-wire"
import { ChainFlowDisclosure } from "@/components/fallback/chain-flow-disclosure"
import { resolveForFlow } from "@/components/fallback/resolve-links"
import { useModelRegistry } from "@/hooks/use-model-registry"
import { useFallbackChains } from "@/hooks/use-fallback-chains"
import type { Employee } from "@/lib/api"
import { engineDisplayName } from "@/lib/engine-names"
import { ChainEditor } from "@/routes/settings/engines/chain-editor"
import { SettingsSelect } from "@/routes/settings/shared"
import { declaredAccountOf, employeeSubject, inheritedChain } from "./employee-fallback"

interface EmployeeFallbackFieldProps {
  employee: Employee
  /** The engine the employee runs on, as the editor now has it. */
  engine: string
  /** The employee's own chain; null inherits. */
  value: FallbackLink[] | null
  onChange: (next: FallbackLink[] | null) => void
}

const INHERIT = "inherit"
const CUSTOM = "custom"

/** "Use the default" or "Custom": the default's chain read-only, or the same rows an
 *  engine's chain has. Switching to Custom starts from the chain the default runs. */
export function EmployeeFallbackField({ employee, engine, value, onChange }: EmployeeFallbackFieldProps) {
  const { data: registry } = useModelRegistry()
  const { data: chains } = useFallbackChains(employee.name)
  if (!registry) return null

  const account = engine === "claude" ? declaredAccountOf(employee.claudeProfile, chains) : undefined
  const inherited = inheritedChain(engine, account, chains)
  const self: FallbackLink = { engine, ...(account ? { profile: account } : {}) }
  const shown = value ?? inherited.links
  const subject = employeeSubject(chains, employee.name)

  return (
    <div className="flex flex-col gap-[var(--space-1)]" data-employee-fallback>
      <SettingsSelect
        value={value === null ? INHERIT : CUSTOM}
        ariaLabel="Fallback chain"
        onChange={(choice) => onChange(choice === CUSTOM ? inherited.links : null)}
        options={[
          { value: INHERIT, label: `Use the default (from ${inherited.label})` },
          { value: CUSTOM, label: "Custom" },
        ]}
      />
      {value === null ? (
        <InheritedRows links={inherited.links} engine={engine} />
      ) : (
        <ChainEditor
          chainName={`${employee.displayName || employee.name} chain`}
          ownEngine={engine}
          self={self}
          where="fallback"
          links={value}
          expanded={value.map(() => false)}
          fields={{ registry, profiles: chains?.profiles.map((p) => p.name) ?? [] }}
          waitsAs={engineDisplayName(engine)}
          onChange={onChange}
        />
      )}
      {shown.length > 0 && <ChainFlowDisclosure links={resolveForFlow(self, shown, subject)} />}
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
