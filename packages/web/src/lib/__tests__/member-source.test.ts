import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemberSource, MEMBER_REFUSAL } from "../member-source"

const request = vi.hoisted(() => vi.fn())
vi.mock("../gateway-transport", () => ({ gatewayTransport: () => ({ request }) }))

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function calls(): { path: string; method: string; body: unknown }[] {
  return request.mock.calls.map(([path, init]) => ({
    path: path as string,
    method: ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase(),
    body: typeof (init as RequestInit | undefined)?.body === "string" ? JSON.parse((init as RequestInit).body as string) : undefined,
  }))
}

const lost = vi.fn()
const source = createMemberSource(lost)
const json = { headers: { "Content-Type": "application/json" } }

beforeEach(() => {
  request.mockImplementation(async () => ok({}))
})
afterEach(() => vi.clearAllMocks())

describe("member request source", () => {
  it("reads a board through the member board route, keeping the query", async () => {
    await source("/api/work-items?department=platform&rootsOnly=true&status=backlog&limit=20", { method: "GET" })
    expect(calls()).toEqual([{ path: "/api/member/boards/platform/todos?rootsOnly=true&status=backlog&limit=20", method: "GET", body: undefined }])
  })

  it("reads a sub-board on the board its anchor Todo is on, with no department asked for", async () => {
    request.mockImplementation(async (path: string) => (path === "/api/member/todos/A-1" ? ok({ workItem: { id: "A-1", department: "platform" } }) : ok({ workItems: [], total: 0 })))
    await source("/api/work-items?descendantOf=A-1&status=backlog&limit=20", { method: "GET" })
    await source("/api/work-items?parent=A-1&status=backlog", { method: "GET" })
    expect(calls().map((c) => c.path)).toEqual([
      "/api/member/todos/A-1",
      "/api/member/boards/platform/todos?descendantOf=A-1&status=backlog&limit=20",
      "/api/member/todos/A-1",
      "/api/member/boards/platform/todos?parent=A-1&status=backlog",
    ])
  })

  it("reads a sub-board on its anchor's root's board, not the anchor's own department", async () => {
    request.mockImplementation(async (path: string) => {
      if (path === "/api/member/todos/C-1") return ok({ workItem: { id: "C-1", department: "design", rootId: "R-1" } })
      if (path === "/api/member/todos/R-1") return ok({ workItem: { id: "R-1", department: "ops", rootId: "R-1" } })
      return ok({ workItems: [], total: 0 })
    })
    await source("/api/work-items?descendantOf=C-1&limit=20", { method: "GET" })
    expect(calls().map((c) => c.path)).toEqual([
      "/api/member/todos/C-1",
      "/api/member/todos/R-1",
      "/api/member/boards/ops/todos?descendantOf=C-1&limit=20",
    ])
  })

  it("answers a sub-board whose root the member cannot read with an empty list", async () => {
    request.mockImplementation(async (path: string) => (path === "/api/member/todos/C-1" ? ok({ workItem: { id: "C-1", department: "design", rootId: "R-1" } }) : ok({ error: "not found" }, 404)))
    const res = await source("/api/work-items?descendantOf=C-1", { method: "GET" })
    expect(await res.json()).toMatchObject({ workItems: [], total: 0 })
  })

  it("answers a sub-board whose anchor the member cannot read with an empty list", async () => {
    request.mockImplementation(async () => ok({ error: "not found" }, 404))
    const res = await source("/api/work-items?descendantOf=A-1&status=backlog", { method: "GET" })
    expect(await res.json()).toMatchObject({ workItems: [], total: 0 })
    expect(calls().map((c) => c.path)).toEqual(["/api/member/todos/A-1"])
  })

  it("reads the Todos a member filed on a board that have left their boards through that board's moved route", async () => {
    await source("/api/work-items?movedOff=true&department=platform", { method: "GET" })
    expect(calls()).toEqual([{ path: "/api/member/boards/platform/moved", method: "GET", body: undefined }])
  })

  it("answers a list with no board, an id list or the attention feed locally, without a request", async () => {
    for (const path of ["/api/work-items?status=backlog", "/api/work-items?ids=A-1,A-2", "/api/work-items?needsAttentionFor=me&department=platform"]) {
      const res = await source(path, { method: "GET" })
      expect(await res.json()).toMatchObject({ workItems: [], total: 0 })
    }
    expect(request).not.toHaveBeenCalled()
  })

  it("maps detail, tree, comments and attachments onto /api/member/todos", async () => {
    await source("/api/work-items/A-1", { method: "GET" })
    await source("/api/work-items/A-1/tree", { method: "GET" })
    await source("/api/work-items/A-1/comments?limit=5", { method: "GET" })
    await source("/api/work-items/A-1/attachments?includeSuperseded=1", { method: "GET" })
    await source("/api/work-items/A-1/attachments/att_1", { method: "GET" })
    expect(calls().map((c) => c.path)).toEqual([
      "/api/member/todos/A-1",
      "/api/member/todos/A-1/tree",
      "/api/member/todos/A-1/comments?limit=5",
      "/api/member/todos/A-1/attachments?includeSuperseded=1",
      "/api/member/todos/A-1/attachments/att_1",
    ])
  })

  it("answers the session list with none, and the session tree with an empty tree the page can read", async () => {
    expect(await (await source("/api/work-items/A-1/sessions", { method: "GET" })).json()).toEqual([])
    const tree = (await (await source("/api/work-items/A-1/sessions?tree=1", { method: "GET" })).json()) as { roots: unknown[]; directory: object; totals: { nodes: number } }
    expect(tree).toMatchObject({ roots: [], directory: {}, totals: { nodes: 0 } })
    expect(request).not.toHaveBeenCalled()
  })

  it("keeps the query on a tree read, and drops the runs a detail read asks for", async () => {
    await source("/api/work-items/A-1/tree?depth=2", { method: "GET" })
    await source("/api/work-items/A-1?include=runs", { method: "GET" })
    await source("/api/work-items/A-1?include=runs&commentsLimit=5", { method: "GET" })
    expect(calls().map((c) => c.path)).toEqual([
      "/api/member/todos/A-1/tree?depth=2",
      "/api/member/todos/A-1",
      "/api/member/todos/A-1?commentsLimit=5",
    ])
  })

  it("fetches each tree of a batch from the member tree route", async () => {
    request.mockImplementation(async (path: string) => ok({ tree: { root: { id: path } } }))
    const res = await source("/api/work-items/trees?ids=A-1,A-2", { method: "GET" })
    expect(calls().map((c) => c.path).sort()).toEqual(["/api/member/todos/A-1/tree", "/api/member/todos/A-2/tree"])
    expect(Object.keys(((await res.json()) as { trees: object }).trees).sort()).toEqual(["A-1", "A-2"])
  })

  it("turns the status PUT into a member POST that carries only the status", async () => {
    await source("/api/work-items/A-1/status", { method: "PUT", ...json, body: JSON.stringify({ status: "done", note: "x", cascade: true }) })
    expect(calls()).toEqual([{ path: "/api/member/todos/A-1/status", method: "POST", body: { status: "done" } }])
  })

  it("turns the person PUT into the member person route, and refuses any other verb on it", async () => {
    await source("/api/work-items/A-1/person", { method: "PUT", ...json, body: JSON.stringify({ person: "user:u1" }) })
    expect(calls()).toEqual([{ path: "/api/member/todos/A-1/person", method: "PUT", body: { person: "user:u1" } }])
    request.mockClear()
    for (const verb of ["GET", "PATCH", "DELETE", "POST"]) {
      const refused = await source("/api/work-items/A-1/person", { method: verb })
      expect([verb, refused.status]).toEqual([verb, 403])
    }
    expect(request).not.toHaveBeenCalled()
  })

  it("turns the labels PUT into a member PATCH", async () => {
    await source("/api/work-items/A-1/labels", { method: "PUT", ...json, body: JSON.stringify({ labels: ["l1"] }) })
    expect(calls()).toEqual([{ path: "/api/member/todos/A-1", method: "PATCH", body: { labels: ["l1"] } }])
  })

  it("passes the version-fenced edit through unchanged", async () => {
    const body = { title: "t", expectedVersion: 4, idempotencyKey: "k" }
    await source("/api/work-items/A-1", { method: "PATCH", ...json, body: JSON.stringify(body) })
    expect(calls()).toEqual([{ path: "/api/member/todos/A-1", method: "PATCH", body }])
  })

  it("files a root Todo on the named board and drops the department from the body", async () => {
    await source("/api/work-items", { method: "POST", ...json, body: JSON.stringify({ title: "t", department: "platform" }) })
    expect(calls()).toEqual([{ path: "/api/member/boards/platform/todos", method: "POST", body: { title: "t" } }])
  })

  it("files a sub-task on the parent's board, found from the parent", async () => {
    request.mockImplementation(async (path: string) => (path === "/api/member/todos/A-1" ? ok({ workItem: { department: "platform" } }) : ok({})))
    await source("/api/work-items", { method: "POST", ...json, body: JSON.stringify({ title: "t", parentId: "A-1" }) })
    expect(calls().map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/member/todos/A-1", "POST /api/member/boards/platform/todos"])
    expect(calls()[1].body).toEqual({ title: "t", parentId: "A-1" })
  })

  it("refuses, without a request, everything that is the operator's", async () => {
    const operatorOnly: [string, string][] = [
      ["POST", "/api/work-items/A-1/dispatch"],
      ["POST", "/api/work-items/A-1/assign"],
      ["POST", "/api/work-items/A-1/archive"],
      ["DELETE", "/api/work-items/A-1/attachments/att_1"],
      ["DELETE", "/api/work-items/A-1"],
      ["GET", "/api/config"],
      ["GET", "/api/sessions"],
      ["POST", "/api/sessions/s1/message"],
      ["GET", "/api/org/employees/x"],
      ["PUT", "/api/config"],
    ]
    for (const [method, path] of operatorOnly) {
      const res = await source(path, { method })
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(((await res.json()) as { error: string }).error).toBe(MEMBER_REFUSAL)
    }
    expect(request).not.toHaveBeenCalled()
  })

  it("builds departments and org from the member's own boards and people", async () => {
    request.mockImplementation(async (path: string) =>
      path === "/api/member/boards" ? ok({ boards: [{ department: "platform", role: "viewer", prefix: "PLT", displayName: "Platform" }] })
        : path === "/api/member/people" ? ok({ people: [], employees: [{ name: "ada", displayName: "Ada", emoji: "🧪" }] })
          : ok({}))
    const departments = (await (await source("/api/departments?includeArchived=true", { method: "GET" })).json()) as { departments: { slug: string; prefix: string }[] }
    expect(departments.departments).toMatchObject([{ slug: "platform", prefix: "PLT" }])
    const org = (await (await source("/api/org", { method: "GET" })).json()) as { employees: { name: string; emoji: string }[]; departments: string[] }
    expect(org.employees).toMatchObject([{ name: "ada", emoji: "🧪" }])
    expect(org.departments).toEqual(["platform"])
  })

  it("reports a 401 from a member route as the session ending", async () => {
    request.mockImplementation(async () => ok({ error: "no" }, 401))
    await source("/api/work-items/A-1", { method: "GET" })
    expect(lost).toHaveBeenCalledTimes(1)
  })
})
