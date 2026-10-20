import { afterEach, describe, expect, it, vi } from "vitest"
import { queryClient } from "@/lib/query-client"
import { clearTalkNavigator, registerTalkNavigator } from "../../tools/router-handle"
import { applyTalkUiEffect } from "../ui-effects"

afterEach(() => {
  clearTalkNavigator()
  vi.restoreAllMocks()
})

describe("verified Talk UI effects", () => {
  it("invalidates the exact Todo surfaces before navigating to the visible result", async () => {
    const order: string[] = []
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async (filters) => {
      order.push(`invalidate:${JSON.stringify(filters?.queryKey)}`)
    })
    registerTalkNavigator(async (path) => { order.push(`navigate:${path}`) })

    await applyTalkUiEffect({
      invalidate: ["todos", "todo:TSK-116", "todo-comments:TSK-116", "todo-sessions:TSK-116"],
      navigate: "/todos/TSK-116",
    })

    expect(invalidate).toHaveBeenCalledTimes(4)
    expect(order.at(-1)).toBe("navigate:/todos/TSK-116")
    expect(order).toContain('invalidate:["work-item","TSK-116"]')
    expect(order).toContain('invalidate:["work-item-comments","TSK-116"]')
    expect(order).toContain('invalidate:["work-item-sessions","TSK-116"]')
  })

  it("maps exact Todo and chat receipts to their live caches", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined)
    await applyTalkUiEffect({ invalidate: ["sessions", "session:s-1", "todo:TSK-116"] })
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey)
    expect(keys).toContainEqual(["sessions"])
    expect(keys).toContainEqual(["sessions", "s-1"])
    expect(keys).toContainEqual(["work-item", "TSK-116"])
  })
})
