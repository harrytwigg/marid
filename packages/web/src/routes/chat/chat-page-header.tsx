import type { ReactNode } from 'react'
import { ChatCopyToast } from '@/components/chat/chat-copy-toast'
import { ChatHeaderPills } from '@/components/chat/chat-tabs'

export function ChatPageHeader({
  hideOnMobile,
  title,
  chatId,
  backTo,
  onBack,
  onNew,
  moreMenu,
  mobileWorkingSet,
  copiedField,
  hideDesktop,
}: {
  hideOnMobile: boolean
  title: string
  chatId: string | null
  backTo?: { label: string; onClick: () => void }
  onBack: () => void
  onNew: () => void
  moreMenu: ReactNode
  mobileWorkingSet?: ReactNode
  copiedField: string | null
  hideDesktop?: boolean
}) {
  return (
    <>
      <ChatHeaderPills {...{ hideOnMobile, hideDesktop, title, chatId, backTo, onBack, onNew, moreMenu, mobileWorkingSet }} />
      {copiedField && <ChatCopyToast placement="page" />}
    </>
  )
}
