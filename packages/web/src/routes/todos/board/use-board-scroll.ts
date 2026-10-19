import { useCallback, useEffect, useRef } from "react"
import type { NavigationType } from "react-router-dom"
import { ANCHOR_ATTRIBUTE, useScrollAnchor } from "@/hooks/use-scroll-anchor"
import { recallBoardScroll, recallBoardScrollLeft, rememberBoardScroll, rememberBoardScrollLeft } from "./board-route"

/** Attribute a board card is identified by; `BoardCard` stamps it. */
const BOARD_CARD_ATTRIBUTE = "data-board-card"

/**
 * Where the reader is on a board, in both directions: remembered per board and
 * put back on POP, and held steady across the reflow a status change causes.
 *
 * Anchoring is off while a card is lifted — the drag reorders the column under
 * the pointer, and correcting for that is fighting the reader, not helping.
 *
 * The same container serves the attention inbox and the grouped board, which
 * identify their rows by different attributes. Anchoring the grouped board only
 * became safe once its cards were given a real `contain-intrinsic-size`: while
 * the estimate was `auto 160px` against a 45px card, the browser revised every
 * skipped card's height as the reader travelled, and a correction measured at a
 * commit boundary chased that phantom to an edge.
 */
export function useBoardScroll(
  key: string,
  navigationType: NavigationType,
  { dragging, attention }: { dragging: boolean; attention: boolean },
) {
  const boardScrollRef = useRef<HTMLDivElement>(null)
  const listScrollRef = useRef<HTMLDivElement>(null)
  const reanchorBoard = useScrollAnchor(boardScrollRef, !dragging, attention ? ANCHOR_ATTRIBUTE : BOARD_CARD_ATTRIBUTE)
  const reanchorList = useScrollAnchor(listScrollRef, !dragging)

  const onBoardScroll = useCallback(() => {
    const el = boardScrollRef.current
    if (el) {
      rememberBoardScroll(key, el.scrollTop)
      rememberBoardScrollLeft(key, el.scrollLeft)
    }
    reanchorBoard()
  }, [key, reanchorBoard])
  const onListScroll = useCallback(() => {
    const el = listScrollRef.current
    if (el) rememberBoardScroll(key, el.scrollTop)
    reanchorList()
  }, [key, reanchorList])

  useEffect(() => {
    const scrollTop = navigationType === "POP" ? recallBoardScroll(key) : 0
    if (boardScrollRef.current) {
      boardScrollRef.current.scrollTop = scrollTop
      // On a phone the strip is the sideways scroller: back from a card, it is on the column it was on.
      boardScrollRef.current.scrollLeft = navigationType === "POP" ? recallBoardScrollLeft(key) : 0
    }
    if (listScrollRef.current) listScrollRef.current.scrollTop = scrollTop
  }, [key, navigationType])

  return { boardScrollRef, listScrollRef, onBoardScroll, onListScroll }
}
