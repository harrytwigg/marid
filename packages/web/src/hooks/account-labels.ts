import { createContext, useContext } from 'react'

/** Display labels of declared opencode accounts, by account name. The registry carries only the name
 *  (`ModelInfo.account`); the label is config, so the surface that has the config provides it. */
export const AccountLabelsContext = createContext<Record<string, string>>({})

export function useAccountLabels(): Record<string, string> {
  return useContext(AccountLabelsContext)
}

/** What a model's account badge reads: the account's label, else its name. */
export function accountBadgeText(account: string, labels: Record<string, string>): string {
  return accountLabel(labels, account) ?? account
}

/** The label for an account name, own keys only (a name such as `constructor` is allowed). */
export function accountLabel(labels: Record<string, string>, account: string): string | undefined {
  return Object.hasOwn(labels, account) ? labels[account] : undefined
}
