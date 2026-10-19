import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FallbackChainsResponse } from "../api-fallback-chains"
import { fetchFallbackChains } from "../api-fallback-chains"

const get = vi.hoisted(() => vi.fn())
vi.mock("../api", () => ({ get }))

const empty: FallbackChainsResponse = { profiles: [], subjects: [] }

beforeEach(() => get.mockReset().mockResolvedValue(empty))

describe("fetchFallbackChains", () => {
  it("asks for every engine's and account's chain", async () => {
    await expect(fetchFallbackChains()).resolves.toBe(empty)
    expect(get).toHaveBeenCalledWith("/api/fallback-chains")
  })

  it("adds an employee's chain by name, encoded", async () => {
    await fetchFallbackChains("a worker/1")
    expect(get).toHaveBeenCalledWith("/api/fallback-chains?employee=a%20worker%2F1")
  })
})
