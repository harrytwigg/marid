import { describe, expect, it, vi } from "vitest"
import { scheduleMenuWarmup } from "../menu-warmup"

type Env = Parameters<typeof scheduleMenuWarmup>[1]

function env(readyState: DocumentReadyState, idle = true) {
  const listeners: Record<string, () => void> = {}
  const requestIdleCallback = vi.fn((callback: () => void, _options?: { timeout: number }) => { callback(); return 1 })
  return {
    listeners,
    requestIdleCallback,
    setTimeout: vi.fn((callback: () => void) => { callback(); return 1 }),
    value: ({
      document: { readyState },
      window: {
        addEventListener: (type: string, listener: () => void) => { listeners[type] = listener },
        setTimeout: undefined,
        requestIdleCallback: idle ? requestIdleCallback : undefined,
      },
    } as unknown) as Env & { window: { setTimeout: unknown } },
  }
}

function make(readyState: DocumentReadyState, idle = true) {
  const e = env(readyState, idle)
  e.value.window.setTimeout = e.setTimeout
  return e
}

describe("scheduleMenuWarmup", () => {
  it("fetches nothing before the page has loaded, and asks for idle time once it has", () => {
    const warm = vi.fn()
    const e = make("loading")

    scheduleMenuWarmup(warm, e.value)
    expect(warm).not.toHaveBeenCalled()
    expect(e.requestIdleCallback).not.toHaveBeenCalled()

    e.listeners.load()

    expect(e.requestIdleCallback).toHaveBeenCalledTimes(1)
    expect(e.requestIdleCallback.mock.calls[0]?.[1]).toEqual({ timeout: 4000 })
    expect(warm).toHaveBeenCalledTimes(1)
  })

  it("goes straight to idle time when the page has already loaded", () => {
    const warm = vi.fn()
    const e = make("complete")

    scheduleMenuWarmup(warm, e.value)

    expect(warm).toHaveBeenCalledTimes(1)
  })

  it("falls back to a timer where there is no idle callback", () => {
    const warm = vi.fn()
    const e = make("complete", false)

    scheduleMenuWarmup(warm, e.value)

    expect(e.setTimeout).toHaveBeenCalledTimes(1)
    expect(warm).toHaveBeenCalledTimes(1)
  })
})
