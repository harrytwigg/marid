import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const request = vi.hoisted(() => vi.fn())
vi.mock("../gateway-transport", () => ({ gatewayTransport: () => ({ request }) }))

import { accountsApi } from "../accounts-api"
import { setMemberSessionLostHandler, setRequestSource } from "../auth"

/* A member's account calls (boards, sessions, people, password) go straight to the gateway rather than through the member
 * source, so a 401 on them must end the session the same way a 401 on a board read does. */

const lost = vi.fn()
const unauthorised = () => new Response(JSON.stringify({ error: "unauthorised" }), { status: 401, headers: { "Content-Type": "application/json" } })

beforeEach(() => {
  setMemberSessionLostHandler(lost)
  request.mockImplementation(async () => unauthorised())
})
afterEach(() => {
  setMemberSessionLostHandler(null)
  setRequestSource(null)
  vi.clearAllMocks()
})

describe("a 401 on an account call", () => {
  it("signs a member's page out when it comes from a member route", async () => {
    setRequestSource(async () => new Response(null, { status: 204 }))
    await expect(accountsApi.listMemberBoards()).rejects.toBeTruthy()
    await expect(accountsApi.listMemberSessions()).rejects.toBeTruthy()
    expect(lost).toHaveBeenCalledTimes(2)
  })

  it("is only a wrong password or token on sign-in, invite and reset", async () => {
    setRequestSource(async () => new Response(null, { status: 204 }))
    await expect(accountsApi.login("a@example.test", "wrong-password")).rejects.toBeTruthy()
    await expect(accountsApi.inspectInvite("tok")).rejects.toBeTruthy()
    expect(lost).not.toHaveBeenCalled()
  })

  it("is not a member's session ending when nobody is signed in as a member", async () => {
    await expect(accountsApi.listMemberBoards()).rejects.toBeTruthy()
    expect(lost).not.toHaveBeenCalled()
  })
})
