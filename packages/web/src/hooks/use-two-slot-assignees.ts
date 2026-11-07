import { useAuthOptional } from "@/routes/auth-provider"

/**
 * Whether a Todo shows two assignees, a person and an agent, or the one it always showed. The person slot exists for the
 * people an instance has: with no accounts there is only the operator and the agent, so every card, row and Todo page
 * reads exactly as it did before accounts existed, and the two-slot surfaces appear with the first account.
 */
export function useTwoSlotAssignees(): boolean {
  return useAuthOptional()?.authState?.hasAccounts === true
}
