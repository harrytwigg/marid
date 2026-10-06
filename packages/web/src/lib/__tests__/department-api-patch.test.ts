import { beforeEach, describe, expect, it, vi } from "vitest"
import { departmentApi, DepartmentPatchError } from "../department-api"

const authFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth", () => ({ authFetch }))
vi.mock("../api", () => ({ get: vi.fn() }))

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

beforeEach(() => authFetch.mockReset())

describe("departmentApi.patch", () => {
  it("sends the scope to the department's route and returns the updated department", async () => {
    authFetch.mockResolvedValue(reply(200, { department: { slug: "side project", scope: "scoped" } }))
    await expect(departmentApi.patch("side project", { scope: "scoped" })).resolves.toMatchObject({ scope: "scoped" })
    const [path, init] = authFetch.mock.calls[0]
    expect(path).toBe("/api/departments/side%20project")
    expect(init).toMatchObject({ method: "PATCH", body: JSON.stringify({ scope: "scoped" }) })
  })

  it("carries a boundary refusal's holders to the caller", async () => {
    authFetch.mockResolvedValue(reply(409, { error: "would strand", code: "department-boundary", holders: [{ todo: "SID-1", assignee: "open-dev" }, { nope: 1 }] }))
    const error = await departmentApi.patch("side", { scope: "dedicated" }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DepartmentPatchError)
    expect(error).toMatchObject({ status: 409, message: "would strand", code: "department-boundary", holders: [{ todo: "SID-1", assignee: "open-dev" }] })
  })

  it("keeps a plain refusal's message and falls back to the status when the body is not JSON", async () => {
    authFetch.mockResolvedValueOnce(reply(409, { error: "department.yaml could not be parsed" }))
    await expect(departmentApi.patch("side", { scope: "open" })).rejects.toMatchObject({ message: "department.yaml could not be parsed", code: undefined, holders: [] })
    authFetch.mockResolvedValueOnce(new Response("<html>", { status: 502 }))
    await expect(departmentApi.patch("side", { scope: "open" })).rejects.toMatchObject({ status: 502, message: "API error: 502" })
  })
})
