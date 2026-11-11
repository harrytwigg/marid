import { beforeEach, describe, expect, it, vi } from "vitest"

/** A board address is a tab of the chat page for the operator. A member has no chat, so the loaders must leave them on the board. */
const auth = vi.hoisted(() => ({ member: false, resolved: false, getAuthState: vi.fn() }))
vi.mock("@/lib/auth", () => ({
  isMemberSession: () => auth.member,
  isPrincipalResolved: () => auth.resolved,
  getAuthState: (...a: unknown[]) => auth.getAuthState(...a),
}))

import { todosBoardLoader, todosIndexLoader } from "../board/todos-index-redirect"

const board = (url = "http://x/todos/b/platform") => ({ request: new Request(url), params: { board: "platform" }, context: {} }) as never
const index = () => ({ request: new Request("http://x/todos"), params: {}, context: {} }) as never

beforeEach(() => {
  auth.member = false
  auth.resolved = false
  auth.getAuthState.mockReset()
})

describe("board loaders and members", () => {
  it("leaves a signed-in member on the board and the index", async () => {
    auth.member = true
    expect(await todosBoardLoader(board())).toBeNull()
    expect(await todosIndexLoader(index())).toBeNull()
    expect(auth.getAuthState).not.toHaveBeenCalled()
  })

  it("asks the gateway on a cold load, and leaves a member alone", async () => {
    auth.getAuthState.mockResolvedValue({ principal: { kind: "member" } })
    expect(await todosBoardLoader(board())).toBeNull()
  })

  it("still sends the operator into the chat tab on a cold load", async () => {
    auth.getAuthState.mockResolvedValue({ principal: { kind: "operator" } })
    const res = (await todosBoardLoader(board())) as Response
    expect(res.headers.get("Location")).toBe("/?open=todos")
  })

  it("does not ask again once the principal is known to be the operator's", async () => {
    auth.resolved = true
    const res = (await todosBoardLoader(board())) as Response
    expect(res.headers.get("Location")).toBe("/?open=todos")
    expect(auth.getAuthState).not.toHaveBeenCalled()
  })

  it("redirects as before when the gateway cannot be asked", async () => {
    auth.getAuthState.mockRejectedValue(new Error("offline"))
    const res = (await todosIndexLoader(index())) as Response
    expect(res.headers.get("Location")).toBe("/?open=todos")
  })
})
