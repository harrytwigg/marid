import type { ReactNode } from 'react'
import { ChatCopyToast } from '@/components/chat/chat-copy-toast'
import { ChatHeaderPills } from '@/components/chat/chat-tabs'

export function ChatPageHeader({
  hideOnMobile,
  title,
  subtitle,
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
  subtitle?: string
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
      <ChatHeaderPills {...{ hideOnMobile, hideDesktop, title, subtitle, chatId, backTo, onBack, onNew, moreMenu, mobileWorkingSet }} />
      {copiedField && <ChatCopyToast placement="page" />}
    </>
  )
}
