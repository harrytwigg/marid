import { useFallbackChains } from '@/hooks/use-fallback-chains'
import { effectivePrimaryProfile, startableProfileNames } from './new-chat-helpers'

/**
 * The declared Claude accounts a new chat may start on, and the remembered
 * profile only if it may actually be sent: confirmed declared and the employee
 * local. The stored choice is never rewritten here, so a chains read that has not
 * loaded (or failed), a removed account or a remote employee just yields no
 * profile until it is valid again.
 */
export function usePrimaryProfiles(enabled: boolean, profile: string | undefined, employeeRemote: boolean | undefined) {
  const { data: chains } = useFallbackChains(undefined, enabled)
  const declared = enabled ? startableProfileNames(chains) : undefined
  return {
    /** Rows to offer; empty while unconfirmed or for a remote employee. */
    profiles: employeeRemote || !declared ? [] : declared,
    effective: enabled ? effectivePrimaryProfile({ profile, declared, employeeRemote }) : undefined,
  }
}
