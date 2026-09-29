import { useCallback } from 'react'
import { useChatGridState } from '../use-chat-grid-state'
import { useGridPickerPane } from '../use-grid-picker-pane'
import { useSplitWorkingSet } from './use-split-working-set'

/** use-chat-grid-workspace.ts with the split layout owning the working set. */
export function useSplitGridWorkspace(
  committedId: string | null,
  sessions: Array<{ id?: unknown }> | undefined,
  systemPrimedId: string | null = null,
) {
  const workingSet = useSplitWorkingSet(committedId, sessions)
  const gridPicker = useGridPickerPane()
  const gridState = useChatGridState({
    committedId,
    workingSet: workingSet.state,
    sessions,
    pickerOpen: Boolean(gridPicker.paneKey),
    systemPrimedId,
  })
  // As upstream: on a phone the picker is the whole grid and nothing inside it can close it,
  // so every navigation away has to release it (use-chat-grid-workspace.ts).
  const closePicker = gridPicker.close
  const { mobile } = gridState.viewport
  const releaseMobilePicker = useCallback(() => {
    if (mobile) closePicker()
  }, [closePicker, mobile])
  return { workingSet, gridPicker, gridState, releaseMobilePicker }
}
