import type { ContextUsageWire } from '@/lib/api-context-usage'

/** A usage answer in the contract's shape; override only what a case is about. */
export function usageFixture(overrides: Partial<ContextUsageWire> = {}): ContextUsageWire {
  return {
    sessionId: 'sess-1',
    engine: 'claude',
    model: 'opus',
    modelLabel: 'Opus 5.5',
    contextTokens: 100_000,
    contextWindow: 200_000,
    autoCompact: { enabled: false, budgetTokens: null },
    compact: { available: true },
    ...overrides,
  }
}
