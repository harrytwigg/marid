// Todos v2 board routing (slice 6, design-doc §1 + implementation notes).
// Pure helpers: the /todos/b/:board param ⇄ BoardId mapping and the per-board
// scroll cache the board restores on POP/breadcrumb return. No React in here.

/** The three board kinds the switcher serves (design-doc §1.1). */
export type BoardId =
  | { kind: "attention" }
  | { kind: "everything" }
  | { kind: "department"; slug: string }

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

/** The canonical key a BoardId serializes to in the URL (and cache keys). */
export function boardKey(id: BoardId): string {
  return id.kind === "department" ? id.slug : id.kind
}

export function boardPath(id: BoardId): string {
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

export function recallBoardScroll(key: string): number {
  return scrollByBoard.get(key) ?? 0
}

/** Test-only: reset the module cache between cases. */
export function clearBoardScrollCache(): void {
  scrollByBoard.clear()
}
