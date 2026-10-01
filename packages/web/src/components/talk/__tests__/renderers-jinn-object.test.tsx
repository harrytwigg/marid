import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ObjectSituation } from "../renderers/jinn-object"
import type { JinnObjectRef } from "../situation-payload"

const gateway = vi.hoisted(() => ({
  getWorkItem: vi.fn(),
  getSession: vi.fn(),
}))

vi.mock("@/lib/api", () => ({ api: gateway }))

function renderObject(object: JinnObjectRef) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ObjectSituation payload={{ kind: "object", object }} onAnswer={vi.fn()} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  gateway.getWorkItem.mockReset()
  gateway.getSession.mockReset()
})

describe("the live embed", () => {
  it("renders a Todo from the query layer", async () => {
    gateway.getWorkItem.mockResolvedValue({
      workItem: { id: "AAA-12", title: "Ship the sheet", status: "in_review", assignee: "a-lead" },
    })

    renderObject({ type: "todo", id: "AAA-12" })

    expect(await screen.findByText("Ship the sheet")).toBeTruthy()
    expect(screen.getByText(/AAA-12/)).toBeTruthy()
    expect(screen.getByText(/in review/)).toBeTruthy()
  })

  it("renders a session from the query layer", async () => {
    gateway.getSession.mockResolvedValue({ title: "Morning triage", employee: "a-lead", status: "idle" })

    renderObject({ type: "session", id: "sess-1" })

    expect(await screen.findByText("Morning triage")).toBeTruthy()
    expect(screen.getByText(/a-lead/)).toBeTruthy()
  })

  it("says it is loading rather than showing an empty card", () => {
    gateway.getWorkItem.mockReturnValue(new Promise(() => {}))

    renderObject({ type: "todo", id: "AAA-12" })

    expect(screen.getByText(/Loading AAA-12/)).toBeTruthy()
    expect(screen.getByRole("button")).toHaveProperty("disabled", true)
  })

  it("says what went wrong rather than showing an empty card", async () => {
    gateway.getSession.mockRejectedValue(new Error("gateway unreachable"))

    renderObject({ type: "session", id: "sess-1" })

    const failure = await waitFor(() => {
      const node = document.querySelector("[data-situation-object-error]")
      expect(node).not.toBeNull()
      return node!
    })
    expect(failure.textContent).toContain("sess-1")
    expect(failure.textContent).toContain("gateway unreachable")
    expect(screen.getByRole("button")).toHaveProperty("disabled", true)
  })

  it("says a missing Todo is missing", async () => {
    gateway.getWorkItem.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))

    renderObject({ type: "todo", id: "AAA-99" })

    const failure = await waitFor(() => {
      const node = document.querySelector("[data-situation-object-error]")
      expect(node).not.toBeNull()
      return node!
    })
    expect(failure.textContent).toContain("AAA-99 no longer exists")
  })
})
