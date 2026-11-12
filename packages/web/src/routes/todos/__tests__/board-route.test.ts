import { describe, it, expect, beforeEach } from "vitest"
import {
  parseBoardParam,
  boardKey,
  boardPath,
  isSameBoard,
  rememberBoardScroll,
  rememberBoardScrollLeft,
  recallBoardScrollLeft,
  recallBoardScroll,
  clearBoardScrollCache,
  DEFAULT_BOARD_PATH,
  subBoardRootOf,
} from "../board/board-route"

describe("parseBoardParam", () => {
  it("maps the two reserved keywords", () => {
    expect(parseBoardParam("attention")).toEqual({ kind: "attention" })
    expect(parseBoardParam("everything")).toEqual({ kind: "everything" })
  })

  // The Home board is gone; links and bookmarks written for it (or for its
  // earlier name, `my`) must still land somewhere real.
  it("keeps the retired `home` and `my` params pointing at Everything", () => {
    expect(parseBoardParam("home")).toEqual({ kind: "everything" })
    expect(parseBoardParam("my")).toEqual({ kind: "everything" })
  })

  it("treats any other slug as a department board", () => {
    expect(parseBoardParam("platform")).toEqual({ kind: "department", slug: "platform" })
    expect(parseBoardParam("customer-success")).toEqual({ kind: "department", slug: "customer-success" })
  })

  it("falls back to Everything for empty or malformed params", () => {
    expect(parseBoardParam(undefined)).toEqual({ kind: "everything" })
    expect(parseBoardParam("")).toEqual({ kind: "everything" })
    expect(parseBoardParam("   ")).toEqual({ kind: "everything" })
    expect(parseBoardParam("-bad")).toEqual({ kind: "everything" })
    expect(parseBoardParam("has space")).toEqual({ kind: "everything" })
  })

  it("normalizes case", () => {
    expect(parseBoardParam("Platform")).toEqual({ kind: "department", slug: "platform" })
    expect(parseBoardParam("HOME")).toEqual({ kind: "everything" })
    expect(parseBoardParam("MY")).toEqual({ kind: "everything" })
  })
})

describe("boardKey / boardPath / isSameBoard", () => {
  it("serializes keywords and department slugs", () => {
    expect(boardKey({ kind: "everything" })).toBe("everything")
    expect(boardKey({ kind: "department", slug: "platform" })).toBe("platform")
    expect(boardPath({ kind: "attention" })).toBe("/todos/b/attention")
    expect(boardPath({ kind: "department", slug: "platform" })).toBe("/todos/b/platform")
    expect(DEFAULT_BOARD_PATH).toBe("/todos/b/everything")
  })

  it("normalizes legacy /todos/b/home and /todos/b/my links onto the Everything path", () => {
    expect(boardPath(parseBoardParam("home"))).toBe("/todos/b/everything")
    expect(boardPath(parseBoardParam("my"))).toBe("/todos/b/everything")
  })

  it("round-trips parse ⇄ path", () => {
    for (const raw of ["attention", "everything", "platform"]) {
      const id = parseBoardParam(raw)
      expect(parseBoardParam(boardPath(id).split("/").pop()!)).toEqual(id)
    }
  })

  it("compares by key", () => {
    expect(isSameBoard({ kind: "everything" }, parseBoardParam("my"))).toBe(true)
    expect(isSameBoard({ kind: "department", slug: "a" }, { kind: "department", slug: "b" })).toBe(false)
  })
})

describe("the subtree board", () => {
  const sub = { kind: "subtree", rootId: "TSK-12", depth: "all" } as const

  it("keys by root and depth, so each depth has its own caches and scroll memory", () => {
    expect(boardKey(sub)).toBe("sub:TSK-12:all")
    expect(boardKey({ ...sub, depth: "children" })).toBe("sub:TSK-12:children")
    expect(isSameBoard(sub, { ...sub, depth: "children" })).toBe(false)
  })

  it("is never produced from a URL param, whatever the param says", () => {
    for (const raw of ["sub:TSK-12:all", "sub:TSK-12:children", "subtree", "sub", "TSK-12"]) {
      expect(parseBoardParam(raw).kind).not.toBe("subtree")
    }
  })

  it("has no route of its own", () => {
    expect(boardPath(sub)).toBe(DEFAULT_BOARD_PATH)
  })

  it("is named back from a card's route state only by its own key", () => {
    expect(subBoardRootOf(boardKey(sub))).toBe("TSK-12")
    expect(subBoardRootOf("sub:TSK-12:children")).toBe("TSK-12")
    expect(subBoardRootOf("platform")).toBeNull()
    expect(subBoardRootOf("sub:nonsense:all")).toBeNull()
    expect(subBoardRootOf(undefined)).toBeNull()
  })
})

describe("board scroll cache", () => {
  beforeEach(() => clearBoardScrollCache())

  it("remembers and recalls per board key", () => {
    rememberBoardScroll("platform", 420)
    rememberBoardScroll("everything", 12)
    expect(recallBoardScroll("platform")).toBe(420)
    expect(recallBoardScroll("everything")).toBe(12)
  })

  it("returns 0 for boards never scrolled", () => {
    expect(recallBoardScroll("attention")).toBe(0)
  })

  it("ignores invalid values", () => {
    rememberBoardScroll("everything", Number.NaN)
    rememberBoardScroll("everything", -5)
    expect(recallBoardScroll("everything")).toBe(0)
  })

  it("remembers how far the phone's strip was scrolled sideways, per board, and forgets it on clear", () => {
    rememberBoardScrollLeft("platform", 679)
    rememberBoardScrollLeft("everything", Number.NaN)
    rememberBoardScrollLeft("everything", -3)
    expect(recallBoardScrollLeft("platform")).toBe(679)
    expect(recallBoardScrollLeft("everything")).toBe(0)
    clearBoardScrollCache()
    expect(recallBoardScrollLeft("platform")).toBe(0)
  })
})
