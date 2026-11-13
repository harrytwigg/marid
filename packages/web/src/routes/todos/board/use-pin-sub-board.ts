import { useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { usePinTodoBoardTab } from "@/components/chat/file-open-context"
import { todoBoardTabHref } from "@/lib/todos-tab-entry"
import { useCanHoldTab } from "@/lib/tab-layout-width"

/** The pop-up's "Pin as tab": pins the sub-board in the chat layout when the pop-up is inside one (the pop-up closes, the
 *  tab is in front), else asks the chat route for it with a one-shot link (lib/todos-tab-entry.ts), which the chat page
 *  consumes. A window the chat page lays out as its mobile layout (the same width rule it uses, lib/tab-layout-width.ts) has no tab
 *  to pin to: there is no such action there, and the pop-up is the board. */
export function usePinSubBoard(rootId: string, onClose: () => void): (() => void) | undefined {
  const pinInLayout = usePinTodoBoardTab()
  const navigate = useNavigate()
  const canHoldTab = useCanHoldTab()
  return useMemo(() => {
    if (!canHoldTab) return undefined
    return () => {
      if (!pinInLayout) return void navigate(todoBoardTabHref(rootId))
      if (pinInLayout(rootId)) onClose()
    }
  }, [canHoldTab, pinInLayout, navigate, rootId, onClose])
}
