import { describe, expect, it, vi } from "vitest"
import { createBrowserGatewayTransport } from "../gateway-transport"

function browserEnvironment(origin = "https://gateway.example:7781") {
  const request = vi.fn(async () => new Response(null, { status: 204 }))
  const navigate = vi.fn()
  return {
    environment: {
      origin,
      request,
      navigate,
    },
    request,
    navigate,
  }
}

describe("browser gateway transport", () => {
  it("resolves HTTP and socket paths against the page origin", () => {
    const { environment } = browserEnvironment()
    const transport = createBrowserGatewayTransport(environment)

    expect(transport.profile.origin).toBe("https://gateway.example:7781")
    expect(transport.httpUrl("/api/sessions")).toBe("https://gateway.example:7781/api/sessions")
    expect(transport.socketUrl("/ws/pty/session-1")).toBe("wss://gateway.example:7781/ws/pty/session-1")
  })

  it("includes the page-origin cookie on every gateway request", async () => {
    const { environment, request } = browserEnvironment()
    const transport = createBrowserGatewayTransport(environment)

    await transport.request("/api/sessions", { method: "GET", credentials: "omit" })

    expect(request).toHaveBeenCalledWith(
      "https://gateway.example:7781/api/sessions",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    )
  })

  it("does not accept another origin disguised as a gateway path", () => {
    const { environment, request } = browserEnvironment()
    const transport = createBrowserGatewayTransport(environment)

    expect(() => transport.request("https://other.example/api/sessions")).toThrow(
      "Gateway paths must be root-relative",
    )
    expect(request).not.toHaveBeenCalled()
  })

  it("rejects a slash-backslash authority escape", () => {
    const { environment, request } = browserEnvironment()
    const transport = createBrowserGatewayTransport(environment)

    expect(() => transport.request("/\\evil.example/api/sessions")).toThrow(
      "Gateway paths must stay on the active profile origin",
    )
    expect(request).not.toHaveBeenCalled()
  })

  it("navigates to the gateway-provided workspace switch URL", () => {
    const { environment, navigate } = browserEnvironment()
    const transport = createBrowserGatewayTransport(environment)

    transport.navigate("https://other.example:7782/todos#hundredfold-pair=PAIR-CODE")

    expect(navigate).toHaveBeenCalledWith("https://other.example:7782/todos#hundredfold-pair=PAIR-CODE")
  })

  it("passes a valid switch URL through without normalizing it", () => {
    const { environment, navigate } = browserEnvironment()
    const transport = createBrowserGatewayTransport(environment)
    const switchUrl = "https://other.example:7782/a/../todos#hundredfold-pair=PAIR-CODE"

    transport.navigate(switchUrl)

    expect(navigate).toHaveBeenCalledWith(switchUrl)
  })
})
