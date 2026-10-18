import { beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, type RenderResult } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { contextUsageApi, type ContextUsageWire } from '@/lib/api-context-usage'
import type { ContextMeterProps } from '../context-meter'
import { SessionStatusCluster } from '../session-status-cluster'

/**
 * Shared set-up for the meter's component tests. Each test file mocks
 * `@/lib/api-context-usage` itself (a mock must be hoisted in the test file);
 * the helpers here reach that mock through the module.
 */
export const api = vi.mocked(contextUsageApi)

/** DOM APIs the popover's primitives call that jsdom lacks, and a fresh mock per test. */
export function useMeterTestEnvironment() {
  beforeAll(() => {
    const g = globalThis as unknown as { ResizeObserver?: unknown }
    g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
    const proto = Element.prototype as unknown as Record<string, unknown>
    proto.scrollIntoView ??= () => {}
    proto.hasPointerCapture ??= () => false
    proto.setPointerCapture ??= () => {}
    proto.releasePointerCapture ??= () => {}
  })
  beforeEach(() => {
    api.getContextUsage.mockReset()
    api.compactSession.mockReset()
  })
}

const BASE: ContextMeterProps = { sessionId: 'sess-1', loading: false }

export interface RenderedMeter extends RenderResult {
  update: (props: Partial<ContextMeterProps>) => void
  client: QueryClient
}

export function renderMeter(props: Partial<ContextMeterProps> = {}): RenderedMeter {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (p: Partial<ContextMeterProps>) => (
    <QueryClientProvider client={client}>
      <SessionStatusCluster {...BASE} {...p} />
    </QueryClientProvider>
  )
  const view = render(tree(props))
  return { ...view, update: (p: Partial<ContextMeterProps>) => view.rerender(tree({ ...props, ...p })), client }
}

export function serve(data: ContextUsageWire) {
  api.getContextUsage.mockResolvedValue(data)
}

export async function openPopover() {
  fireEvent.click(await screen.findByTestId('context-meter'))
  return screen.findByRole('dialog')
}
