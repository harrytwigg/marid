import { useCallback, useState } from "react"
import { useLocation, useNavigate, useSearchParams } from "react-router-dom"

const VIEW_PARAM = "view"
const BOARD_VIEW = "board"
/** Marks the history entry the button pushed to open the pop-up, so closing knows there is an entry to go back to. */
const PUSHED_KEY = "subBoardPushed"

function record(state: unknown): Record<string, unknown> {
  return state !== null && typeof state === "object" ? (state as Record<string, unknown>) : {}
}

/** Whether a Todo's sub-board pop-up is open over its page, and the two moves.
 *
 *  At the Todo's route it is the address: `?view=board` opens it, so the board can be linked. Opening it from the button is
 *  a push (Back closes it), and closing it undoes that push, so the page is one entry again and its crumb's Back leads where
 *  it did before the pop-up. A pop-up opened by a link has no earlier entry of the page to go back to: it drops the
 *  parameter with a replace. Both writes keep the entry's `location.state` (where the page was opened from, its Back
 *  target), which a bare parameter write would drop. In a layout tab (`embedded`) the route is the chat's, which a pop-up
 *  must not write, so it is state. */
export function useSubBoardView(embedded: boolean) {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { state } = useLocation()
  const [held, setHeld] = useState(false)
  const open = embedded ? held : params.get(VIEW_PARAM) === BOARD_VIEW
  const show = useCallback(() => {
    if (embedded) return setHeld(true)
    setParams((current) => {
      const next = new URLSearchParams(current)
      next.set(VIEW_PARAM, BOARD_VIEW)
      return next
    }, { state: { ...record(state), [PUSHED_KEY]: true } })
  }, [embedded, setParams, state])
  const hide = useCallback(() => {
    if (embedded) return setHeld(false)
    if (record(state)[PUSHED_KEY] === true) return void navigate(-1)
    setParams((current) => {
      const next = new URLSearchParams(current)
      next.delete(VIEW_PARAM)
      return next
    }, { replace: true, state })
  }, [embedded, navigate, setParams, state])
  return { open, show, hide }
}
