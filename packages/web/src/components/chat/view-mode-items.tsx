import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu'
import { SESSION_MENU_ITEM_CLASS } from '@/components/chat/session-row-menu'
import { cn } from '@/lib/utils'
import type { ViewMode } from '@/lib/view-mode'

// The Chat/CLI choice shared by the header's More menu and a pane's title-bar menu, so the two read
// alike: two radio items, which arrows, typeahead and Enter reach (a pair of buttons inside the menu
// are skipped by the menu's own keys). Choosing one closes the menu.
const VIEW_ITEM_CLASS = cn(
  SESSION_MENU_ITEM_CLASS,
  'pl-8 data-[selected]:bg-[var(--accent-fill)] data-[selected]:text-[var(--accent)] disabled:opacity-45',
)

interface ViewModeItemsProps {
  viewMode: ViewMode
  cliModeAvailable: boolean
  viewSwitchLocked: boolean
  cliTitle: string | undefined
  onChange: (mode: ViewMode) => void
}

export function ViewModeItems({ viewMode, cliModeAvailable, viewSwitchLocked, cliTitle, onChange }: ViewModeItemsProps) {
  const choose = (mode: string) => {
    if (viewSwitchLocked || (mode === 'cli' && !cliModeAvailable)) return
    onChange(mode === 'cli' ? 'cli' : 'chat')
  }
  return (
    <DropdownMenuRadioGroup aria-label="View" value={viewMode} onValueChange={choose}>
      <DropdownMenuRadioItem value="chat" className={VIEW_ITEM_CLASS} disabled={viewSwitchLocked} title={viewSwitchLocked ? cliTitle : undefined}>
        Chat
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="cli" className={cn(VIEW_ITEM_CLASS, 'font-mono')} disabled={!cliModeAvailable || viewSwitchLocked} title={cliTitle}>
        CLI
      </DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  )
}
