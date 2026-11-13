import { useCallback, useState } from "react"
import { useLocation, useSearchParams } from "react-router-dom"

const VIEW_PARAM = "view"
const BOARD_VIEW = "board"

/** Whether a Todo's sub-board pop-up is open over its page, and the two moves.
 *
 *  At the Todo's route it is the address: `?view=board` opens it, so the board can be linked, opening it from the button
 *  is a push (Back closes it) and closing it drops the parameter with a replace (the address stays one entry, without
 *  `view`). Both writes keep the entry's `location.state` (where the page was opened from, its Back target), which a
 *  bare parameter write would drop. In a layout tab (`embedded`) the route is the chat's, which a pop-up must not write, so it is state. */
export function useSubBoardView(embedded: boolean) {
  const [params, setParams] = useSearchParams()
  const { state } = useLocation()
  const [held, setHeld] = useState(false)
  const open = embedded ? held : params.get(VIEW_PARAM) === BOARD_VIEW
  const show = useCallback(() => {
    if (embedded) return setHeld(true)
    setParams((current) => {
      const next = new URLSearchParams(current)
      next.set(VIEW_PARAM, BOARD_VIEW)
      return next
    }, { state })
  }, [embedded, setParams, state])
  const hide = useCallback(() => {
    if (embedded) return setHeld(false)
    setParams((current) => {
      const next = new URLSearchParams(current)
      next.delete(VIEW_PARAM)
      return next
    }, { replace: true, state })
  }, [embedded, setParams, state])
  return { open, show, hide }
}
