// Todos v2 board routing (slice 6, design-doc §1 + implementation notes).
// Pure helpers: the /todos/b/:board param ⇄ BoardId mapping and the per-board
// scroll cache the board restores on POP/breadcrumb return. No React in here.

/** The board kinds. The first three are the ones the switcher serves (design-doc §1.1) and the URL can name.
 *  A subtree is one Todo's sub-Todos as a board: only a location that holds it in memory or in a tab's own
 *  state can ask for it, so `parseBoardParam` never produces one and no route addresses it. */
export type BoardId =
  | { kind: "attention" }
  | { kind: "everything" }
  | { kind: "department"; slug: string }
  | { kind: "subtree"; rootId: string; depth: SubBoardDepth }

/** `children`: the Todo's direct sub-Todos, each carrying its own tray. `all`: every level, flattened. */
export type SubBoardDepth = "children" | "all"

export const DEFAULT_BOARD_PATH = "/todos/b/everything"

/** Parse the :board route param. Unknown/empty values fall back to Everything
 *  rather than erroring — a stale department link should land somewhere sane,
 *  not on a dead page. `home` and `my` name boards that no longer exist; they
 *  fall through to Everything too, so every link and bookmark written before
 *  the Home board was removed keeps working. */
export function parseBoardParam(param: string | undefined | null): BoardId {
  const value = (param ?? "").trim().toLowerCase()
  if (!value || value === "home" || value === "my" || value === "everything") return { kind: "everything" }
  if (value === "attention") return { kind: "attention" }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) return { kind: "everything" }
  return { kind: "department", slug: value }
}

/** The canonical key a BoardId serializes to: the URL for the route boards, and the cache keys, scroll memory and
 *  optimistic-move tag of every board. A subtree's key can never be a department slug (it holds a colon). */
export function boardKey(id: BoardId): string {
  if (id.kind === "department") return id.slug
  if (id.kind === "subtree") return `sub:${id.rootId}:${id.depth}`
  return id.kind
}

/** The root Todo of a sub-board key (`fromBoard` on a card's route state), or null for any other key. */
export function subBoardRootOf(key: string | undefined): string | null {
  const match = /^sub:([A-Za-z0-9]+-[1-9][0-9]*):(?:children|all)$/.exec(key ?? "")
  return match ? match[1] : null
}

/** The route of a board. A subtree has none: asking for it lands on the default board. */
export function boardPath(id: BoardId): string {
  if (id.kind === "subtree") return DEFAULT_BOARD_PATH
  return `/todos/b/${encodeURIComponent(boardKey(id))}`
}

export function isSameBoard(a: BoardId, b: BoardId): boolean {
  return boardKey(a) === boardKey(b)
}

// ── Per-board scroll cache (design-doc implementation notes) ────────────────
// Module-level so it survives route unmounts within one app session; POP or a
// breadcrumb return restores the exact scrollTop, a fresh PUSH starts at 0.
const scrollByBoard = new Map<string, number>()

export function rememberBoardScroll(key: string, top: number): void {
  if (!Number.isFinite(top) || top < 0) return
  scrollByBoard.set(key, top)
}

// The phone's strip scrolls sideways, so the column the reader was on is remembered too.
const scrollLeftByBoard = new Map<string, number>()

export function rememberBoardScrollLeft(key: string, left: number): void {
  if (!Number.isFinite(left) || left < 0) return
  scrollLeftByBoard.set(key, left)
}

export function recallBoardScrollLeft(key: string): number {
  return scrollLeftByBoard.get(key) ?? 0
}

export function recallBoardScroll(key: string): number {
  return scrollByBoard.get(key) ?? 0
}

/** Test-only: reset the module cache between cases. */
export function clearBoardScrollCache(): void {
  scrollByBoard.clear()
  scrollLeftByBoard.clear()
}
