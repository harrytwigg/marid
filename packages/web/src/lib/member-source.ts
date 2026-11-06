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

const EMPTY_SESSION_TREE = { roots: [], directory: {}, truncated: { depth: false, count: false }, totals: { nodes: 0, live: 0 } }

const EMPTY_LIST = { workItems: [], total: 0, nextOffset: null, totals: {} }

interface BoardRow { department: string; role?: string; prefix?: string; displayName?: string }

async function memberBoards(): Promise<BoardRow[]> {
  const res = await gatewayTransport().request("/api/member/boards", { method: "GET" })
  if (!res.ok) return []
  return ((await res.json()) as { boards?: BoardRow[] }).boards ?? []
}

type Stub = (path: string) => Promise<Response> | Response

const ONBOARDED = {
  needed: false, onboarded: true, sessionsCount: 0, hasEmployees: true, companyName: null, companyPrefix: null,
  todoPrefix: null, todoPrefixFrozen: true, portalName: null, operatorName: null, operatorEmoji: null,
}

async function departmentsStub(): Promise<Response> {
  const boards = await memberBoards()
  return json({
    departments: boards.map((board) => ({
      slug: board.department, prefix: board.prefix ?? "", displayName: board.displayName ?? null, createdAt: "", todoCount: 0,
    })),
  })
}

async function orgStub(): Promise<Response> {
  const [boards, peopleRes] = await Promise.all([memberBoards(), gatewayTransport().request("/api/member/people", { method: "GET" })])
  const employees = peopleRes.ok
    ? ((await peopleRes.json()) as { employees?: { name: string; displayName?: string; emoji?: string }[] }).employees ?? []
    : []
  return json({
    departments: boards.map((board) => board.department),
    employees: employees.map((e) => ({
      name: e.name, displayName: e.displayName ?? e.name, emoji: e.emoji, department: "", rank: "employee", engine: "", model: "", persona: "",
    })),
    hierarchy: { root: null, sorted: employees.map((e) => e.name), warnings: [] },
  })
}

/** Reads that the shared surfaces make for things a member has no business with. Each answers what
 *  "nothing here" looks like for that surface, so the surface renders instead of erroring. The
 *  department and org lookups are built from the member's own boards and people. */
const STUBS: Record<string, Stub> = {
  "/api/onboarding": () => json(ONBOARDED),
  "/api/features": () => json({ notesEnabled: false, staleChat: { enabled: false } }),
  "/api/labels": () => json({ labels: [] }),
  "/api/sprints": () => json({ sprints: [] }),
  "/api/departments": departmentsStub,
  "/api/org": orgStub,
}

async function stubFor(path: string): Promise<Response | null> {
  const bare = path.split("?")[0]
  const stub = bare.startsWith("/api/sprints/") ? STUBS["/api/sprints"] : STUBS[bare]
  return stub ? stub(path) : null
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

type Handler = (m: RegExpMatchArray, path: string, init: RequestInit) => Promise<Response> | Response

/** One member route for a shared route: the verbs it answers, and what answers them. Any other verb is refused. */
interface Rule { pattern: RegExp; verbs: string[]; handle: Handler }

const mine = (id: string, tail = "") => `/api/member/todos/${id}${tail}`
const withQuery = (path: string) => (path.includes("?") ? `?${query(path)}` : "")
/** A Todo read without `include`: the Todo page asks for its runs that way, and runs are never a member's to read. */
function detailQuery(path: string): string {
  const params = query(path)
  params.delete("include")
  const rest = params.toString()
  return rest ? `?${rest}` : ""
}

async function readTrees(path: string): Promise<Response> {
  const ids = (query(path).get("ids") ?? "").split(",").filter(Boolean)
  const trees: Record<string, unknown> = {}
  await Promise.all(ids.map(async (id) => {
    const res = await gatewayTransport().request(mine(enc(id), "/tree"), { method: "GET" })
    if (res.ok) trees[id] = ((await res.json()) as { tree: unknown }).tree
  }))
  return json({ trees })
}

function readBoard(path: string, init: RequestInit): Promise<Response> | Response {
  const params = query(path)
  const department = params.get("department")
  // A list that names ids, or no board, has nothing to read from: members read a board at a time.
  if (!department || params.has("ids") || params.has("needsAttentionFor")) return json(EMPTY_LIST)
  params.delete("department")
  const rest = params.toString()
  return forward(`/api/member/boards/${enc(department)}/todos${rest ? `?${rest}` : ""}`, init)
}

async function boardOf(body: Record<string, unknown>): Promise<string | null> {
  if (typeof body.department === "string") return body.department
  if (typeof body.parentId !== "string") return null
  const parent = await gatewayTransport().request(mine(enc(body.parentId)), { method: "GET" })
  if (!parent.ok) return null
  return ((await parent.json()) as { workItem?: { department?: string | null } }).workItem?.department ?? null
}

async function createTodo(init: RequestInit): Promise<Response> {
  const body = readBody(init)
  const department = await boardOf(body)
  if (!department) return json({ error: "A board is needed to create a Todo" }, 400)
  const { department: _department, ...rest } = body
  return forward(`/api/member/boards/${enc(department)}/todos`, init, { body: rest })
}

const RULES: Rule[] = [
  { pattern: TREES, verbs: ["GET"], handle: (_m, path) => readTrees(path) },
  { pattern: TREE, verbs: ["GET"], handle: (m, path, init) => forward(mine(m[1], `/tree${withQuery(path)}`), init) },
  {
    pattern: STATUS,
    verbs: ["PUT", "POST"],
    handle: (m, _p, init) => forward(mine(m[1], "/status"), init, { method: "POST", body: { status: readBody(init).status } }),
  },
  { pattern: COMMENT, verbs: ["PATCH", "DELETE"], handle: (m, _p, init) => forward(mine(m[1], `/comments/${m[2]}`), init) },
  { pattern: COMMENTS, verbs: ["GET", "POST"], handle: (m, path, init) => forward(mine(m[1], `/comments${withQuery(path)}`), init) },
  { pattern: ATTACHMENT, verbs: ["GET"], handle: (m, _p, init) => forward(mine(m[1], `/attachments/${m[2]}`), init) },
  {
    pattern: ATTACHMENTS,
    verbs: ["GET", "POST"],
    handle: (m, path, init) => forward(mine(m[1], `/attachments${method(init) === "GET" ? withQuery(path) : ""}`), init),
  },
  {
    pattern: LABELS,
    verbs: ["PUT"],
    handle: (m, _p, init) => forward(mine(m[1]), init, { method: "PATCH", body: { labels: readBody(init).labels } }),
  },
  // The Todo page asks for the session list, and for the session tree with `?tree=1`: a member has no sessions in either.
  { pattern: SESSIONS, verbs: ["GET"], handle: (_m, path) => json(query(path).has("tree") ? EMPTY_SESSION_TREE : []) },
  { pattern: ONE, verbs: ["GET", "PATCH"], handle: (m, path, init) => forward(mine(m[1], method(init) === "GET" ? detailQuery(path) : ""), init) },
]

async function route(path: string, init: RequestInit): Promise<Response> {
  const verb = method(init)
  if (LIST.test(path)) {
    if (verb === "GET") return readBoard(path, init)
    return verb === "POST" ? createTodo(init) : refuse()
  }
  for (const rule of RULES) {
    const m = rule.pattern.exec(path)
    if (m) return rule.verbs.includes(verb) ? rule.handle(m, path, init) : refuse()
  }
  const stub = verb === "GET" ? await stubFor(path) : null
  return stub ?? refuse()
}

/** The member route for an attachment's bytes, used where the URL goes into an `<img>` or a link. */
export function memberAttachmentPath(todoId: string, attachmentId: string): string {
  return `/api/member/todos/${enc(todoId)}/attachments/${enc(attachmentId)}`
}
