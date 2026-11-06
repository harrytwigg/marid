// The member data source: the one seam between the shared Todo surfaces and a board member's API.
//
// The board, the Todo page and their hooks all talk to `/api/work-items/*` through `authFetch`. For a
// member that traffic is answered here instead: mapped onto `/api/member/*`, answered from what the
// member's own boards already say, or refused without leaving the browser. A member's session can
// therefore only ever name routes the gateway allowlists, and the components stay the operator's own.

import { gatewayTransport } from "./gateway-transport"
export const MEMBER_REFUSAL = "Not available to board members"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const refuse = () => json({ error: MEMBER_REFUSAL }, 403)

function method(init: RequestInit): string {
  return (init.method ?? "GET").toUpperCase()
}

function forward(path: string, init: RequestInit, overrides: { method?: string; body?: unknown } = {}): Promise<Response> {
  const next: RequestInit = { ...init }
  if (overrides.method) next.method = overrides.method
  if (overrides.body !== undefined) {
    next.body = JSON.stringify(overrides.body)
    next.headers = { "Content-Type": "application/json" }
  }
  return gatewayTransport().request(path, next)
}

function readBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== "string") return {}
  try {
    const parsed: unknown = JSON.parse(init.body)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const enc = encodeURIComponent
const ID = "([^/?#]+)"
const re = (tail: string) => new RegExp(`^/api/work-items${tail}(?:\\?.*)?$`)

const LIST = re("")
const TREES = re("/trees")
const ONE = re(`/${ID}`)
const TREE = re(`/${ID}/tree`)
const STATUS = re(`/${ID}/status`)
const COMMENTS = re(`/${ID}/comments`)
const COMMENT = re(`/${ID}/comments/${ID}`)
const ATTACHMENTS = re(`/${ID}/attachments`)
const ATTACHMENT = re(`/${ID}/attachments/${ID}`)
const LABELS = re(`/${ID}/labels`)
const SESSIONS = re(`/${ID}/sessions`)

function query(path: string): URLSearchParams {
  const at = path.indexOf("?")
  return new URLSearchParams(at < 0 ? "" : path.slice(at + 1))
}

const EMPTY_LIST = { workItems: [], total: 0, nextOffset: null, totals: {} }

interface BoardRow { department: string; role?: string; prefix?: string; displayName?: string }

async function memberBoards(): Promise<BoardRow[]> {
  const res = await gatewayTransport().request("/api/member/boards", { method: "GET" })
  if (!res.ok) return []
  return ((await res.json()) as { boards?: BoardRow[] }).boards ?? []
}

/** Reads that the shared surfaces make for things a member has no business with. Each answers what
 *  "nothing here" looks like for that surface, so the surface renders instead of erroring. The
 *  department and org lookups are built from the member's own boards and people. */
async function stubFor(path: string): Promise<Response | null> {
  const bare = path.split("?")[0]
  if (bare === "/api/onboarding") {
    return json({
      needed: false, onboarded: true, sessionsCount: 0, hasEmployees: true, companyName: null, companyPrefix: null,
      todoPrefix: null, todoPrefixFrozen: true, portalName: null, operatorName: null, operatorEmoji: null,
    })
  }
  if (bare === "/api/features") return json({ notesEnabled: false, staleChat: { enabled: false } })
  if (bare === "/api/labels") return json({ labels: [] })
  if (bare === "/api/sprints" || bare.startsWith("/api/sprints/")) return json({ sprints: [] })
  if (SESSIONS.test(path)) return json([])
  if (bare === "/api/departments") {
    const boards = await memberBoards()
    return json({
      departments: boards.map((board) => ({
        slug: board.department, prefix: board.prefix ?? "", displayName: board.displayName ?? null, createdAt: "", todoCount: 0,
      })),
    })
  }
  if (bare === "/api/org") {
    const [boards, peopleRes] = await Promise.all([
      memberBoards(),
      gatewayTransport().request("/api/member/people", { method: "GET" }),
    ])
    const employees = peopleRes.ok
      ? ((await peopleRes.json()) as { employees?: { name: string; displayName?: string; emoji?: string }[] }).employees ?? []
      : []
    return json({
      departments: boards.map((board) => board.department),
      employees: employees.map((e) => ({
        name: e.name, displayName: e.displayName ?? e.name, emoji: e.emoji, department: "", rank: "employee",
        engine: "", model: "", persona: "",
      })),
      hierarchy: { root: null, sorted: employees.map((e) => e.name), warnings: [] },
    })
  }
  return null
}

/** The source a member's requests go through. */
export function createMemberSource(onSessionLost?: () => void) {
  return async function memberRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await route(path, init)
    // A 401 from a member route is the gateway saying this session is over (revoked, disabled, expired).
    if (res.status === 401) onSessionLost?.()
    return res
  }
}

async function route(path: string, init: RequestInit): Promise<Response> {
  const verb = method(init)

  if (TREES.test(path) && verb === "GET") {
    const ids = (query(path).get("ids") ?? "").split(",").filter(Boolean)
    const trees: Record<string, unknown> = {}
    await Promise.all(ids.map(async (id) => {
      const res = await gatewayTransport().request(`/api/member/todos/${enc(id)}/tree`, { method: "GET" })
      if (res.ok) trees[id] = ((await res.json()) as { tree: unknown }).tree
    }))
    return json({ trees })
  }

  if (LIST.test(path)) {
    if (verb === "GET") {
      const params = query(path)
      const department = params.get("department")
      // A list that names ids, or no board, has nothing to read from: members read a board at a time.
      if (!department || params.has("ids") || params.has("needsAttentionFor")) return json(EMPTY_LIST)
      params.delete("department")
      const rest = params.toString()
      return forward(`/api/member/boards/${enc(department)}/todos${rest ? `?${rest}` : ""}`, init)
    }
    if (verb === "POST") {
      const body = readBody(init)
      let department = typeof body.department === "string" ? body.department : null
      if (!department && typeof body.parentId === "string") {
        const parent = await gatewayTransport().request(`/api/member/todos/${enc(body.parentId)}`, { method: "GET" })
        if (parent.ok) department = ((await parent.json()) as { workItem?: { department?: string | null } }).workItem?.department ?? null
      }
      if (!department) return json({ error: "A board is needed to create a Todo" }, 400)
      const { department: _department, ...rest } = body
      return forward(`/api/member/boards/${enc(department)}/todos`, init, { body: rest })
    }
    return refuse()
  }

  let m: RegExpMatchArray | null
  if ((m = TREE.exec(path))) return verb === "GET" ? forward(`/api/member/todos/${m[1]}/tree`, init) : refuse()
  if ((m = STATUS.exec(path))) {
    if (verb !== "PUT" && verb !== "POST") return refuse()
    const { status } = readBody(init)
    return forward(`/api/member/todos/${m[1]}/status`, init, { method: "POST", body: { status } })
  }
  if ((m = COMMENT.exec(path))) {
    return verb === "PATCH" || verb === "DELETE" ? forward(`/api/member/todos/${m[1]}/comments/${m[2]}`, init) : refuse()
  }
  if ((m = COMMENTS.exec(path))) {
    return verb === "GET" || verb === "POST" ? forward(`/api/member/todos/${m[1]}/comments${path.includes("?") ? `?${query(path)}` : ""}`, init) : refuse()
  }
  if ((m = ATTACHMENT.exec(path))) return verb === "GET" ? forward(`/api/member/todos/${m[1]}/attachments/${m[2]}`, init) : refuse()
  if ((m = ATTACHMENTS.exec(path))) {
    return verb === "GET" || verb === "POST" ? forward(`/api/member/todos/${m[1]}/attachments${verb === "GET" && path.includes("?") ? `?${query(path)}` : ""}`, init) : refuse()
  }
  if ((m = LABELS.exec(path))) {
    if (verb !== "PUT") return refuse()
    const { labels } = readBody(init)
    return forward(`/api/member/todos/${m[1]}`, init, { method: "PATCH", body: { labels } })
  }
  if ((m = SESSIONS.exec(path))) return verb === "GET" ? json([]) : refuse()
  if ((m = ONE.exec(path))) {
    if (verb === "GET") return forward(`/api/member/todos/${m[1]}`, init)
    if (verb === "PATCH") return forward(`/api/member/todos/${m[1]}`, init)
    return refuse()
  }

  if (verb === "GET") {
    const stub = await stubFor(path)
    if (stub) return stub
  }
  return refuse()
}

/** The member route for an attachment's bytes, used where the URL goes into an `<img>` or a link. */
export function memberAttachmentPath(todoId: string, attachmentId: string): string {
  return `/api/member/todos/${enc(todoId)}/attachments/${enc(attachmentId)}`
}
