import { useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { usePinTodoBoardTab } from "@/components/chat/file-open-context"
import { todoBoardTabHref } from "@/lib/todos-tab-entry"
import { useIsBoardMobile } from "./phone-board"

/** The pop-up's "Pin as tab": pins the sub-board in the chat layout when the pop-up is inside one (the pop-up closes, the
 *  tab is in front), else asks the chat route for it with a one-shot link (lib/todos-tab-entry.ts), which the chat page
 *  consumes. A phone has no tab to pin to: there is no such action, and the pop-up, which is full-screen there, is the board. */
export function usePinSubBoard(rootId: string, onClose: () => void): (() => void) | undefined {
  const pinInLayout = usePinTodoBoardTab()
  const navigate = useNavigate()
  const mobile = useIsBoardMobile()
  return useMemo(() => {
    if (mobile) return undefined
    return () => {
      if (!pinInLayout) return void navigate(todoBoardTabHref(rootId))
      if (pinInLayout(rootId)) onClose()
    }
  }, [mobile, pinInLayout, navigate, rootId, onClose])
}
