import { Check } from '@/components/ui/icon'

const TOAST_CLASS = 'z-10 flex items-center gap-1 rounded-full bg-[var(--material-thick)] px-2.5 py-1 text-caption1 font-medium text-[var(--accent)] shadow-[var(--shadow-overlay)]'

export function ChatCopyToast({ placement }: { placement: 'page' | 'pane' }) {
  if (placement === 'page') {
    return (
      <div data-testid="chat-page-copy-toast" data-chat-page-copy-toast className={`absolute right-4 top-[58px] ${TOAST_CLASS}`}>
        <Check className="size-3" /> Copied!
      </div>
    )
  }
  return (
    <div data-testid="chat-pane-copy-toast" className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
      <div className={TOAST_CLASS}><Check className="size-3" /> Copied!</div>
    </div>
  )
}
