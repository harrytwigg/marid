import type React from "react"
import type { EngineLimitAccountSnapshot } from "@/lib/api"
import { useEngineLimits } from "@/routes/limits/use-engine-limits"
import type { OpencodeAccountSettings } from "./chain-model"

/** The accounts as written under `engines.opencode.accounts`, in config order. */
export function opencodeAccountsOf(accounts: Record<string, OpencodeAccountSettings> | undefined): [string, OpencodeAccountSettings][] {
  return Object.entries(accounts ?? {})
}

function usageLimitsText(account: OpencodeAccountSettings): string | null {
  const table = account.usageLimits?.monthlyUsd
  const entries = table && typeof table === "object" ? Object.entries(table) : []
  if (entries.length === 0) return null
  return entries.map(([model, usd]) => `${model === "*" ? "all models" : model} $${usd}/mo`).join(", ")
}

function keyStateOf(account: OpencodeAccountSettings, live: EngineLimitAccountSnapshot | undefined): "set" | "not set" | null {
  if (account.keyEnv === undefined || live?.keySet === undefined) return null
  return live.keySet ? "set" : "not set"
}

function Field({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[var(--text-tertiary)]">{name}</dt>
      <dd className="truncate">{children}</dd>
    </>
  )
}

function KeyField({ keyEnv, state }: { keyEnv: string | undefined; state: "set" | "not set" | null }) {
  if (keyEnv === undefined) return null
  return (
    <Field name="Key">
      <span data-testid="key-var">
        {keyEnv}
        {state && <span style={{ color: state === "set" ? "var(--system-green)" : "var(--system-orange)" }}> · {state}</span>}
      </span>
    </Field>
  )
}

function Row({ name, account, live }: { name: string; account: OpencodeAccountSettings; live: EngineLimitAccountSnapshot | undefined }) {
  const limits = usageLimitsText(account)
  return (
    <div data-opencode-account={name} className="rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] p-[var(--space-2)] text-[length:var(--text-caption1)]">
      <div className="flex items-baseline justify-between gap-[var(--space-3)]">
        <span className="min-w-0 truncate text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">{account.label ?? name}</span>
        <span className="shrink-0 text-[var(--text-tertiary)]">{name}</span>
      </div>
      <dl className="mt-[var(--space-1)] grid grid-cols-[max-content_1fr] gap-x-[var(--space-3)] gap-y-[2px] text-[var(--text-secondary)]">
        <Field name="Provider">{account.provider ?? name}</Field>
        <Field name="Base">{account.base ?? "built-in"}</Field>
        <KeyField keyEnv={account.keyEnv} state={keyStateOf(account, live)} />
        <Field name="Models">{account.models?.length ? `${account.models.length}: ${account.models.join(", ")}` : "all"}</Field>
        {limits && <Field name="Limits">{limits}</Field>}
      </dl>
      {live?.problems?.map((problem) => (
        <div key={problem} className="mt-[var(--space-1)] text-[var(--system-orange)]" data-testid="account-problem">{problem}</div>
      ))}
    </div>
  )
}

/** The declared opencode accounts, read-only. Key state and problems come from the
 *  limits snapshot, which only this list asks for (so an instance with no accounts
 *  never makes the request). */
export function OpencodeAccountsList({ accounts }: { accounts: [string, OpencodeAccountSettings][] }) {
  const { data } = useEngineLimits()
  const live = data?.accounts?.opencode ?? []
  return (
    <div className="mt-[var(--space-2)] flex flex-col gap-[var(--space-1)]" data-testid="opencode-accounts">
      <div className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]">Accounts</div>
      {accounts.map(([name, account]) => (
        <Row key={name} name={name} account={account} live={live.find((l) => l.account === name || l.provider === (account.provider ?? name))} />
      ))}
    </div>
  )
}
