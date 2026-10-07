/** The split layout's surface for routes/chat/page.tsx: one import, so the seam stays small. */
export { SplitChatGrid, SplitGridContext } from './split-chat-grid'
export { SplitDropOverlay } from './split-drop-overlay'
export { useSplitGridAdd } from './use-split-grid-add'
export { useSplitGridWorkspace } from './use-split-grid-workspace'
export { focusedGroupTabs, hasTabbedGroup, isLastChatWithTabs } from './split-layout'
export { isChatTabId, isNewChatTabId, parseNewChatTabId } from './tab-kind'
export { selectTab } from './pane-tab-ops'
