import type { Message } from '@/lib/conversations'
import { turnSpacerClass } from './turn-spacer'

/**
 * The pre-first-token running cue. It opens on the same turn spacer as the reply
 * that replaces it: a fixed 4px inset sat 20px tighter than its own successor,
 * so the transcript stepped down the moment the answer landed.
 */
export function ThinkingIndicator({ prevRole }: { prevRole: Message['role'] }) {
  return (
    <div>
      <div className={turnSpacerClass(prevRole, 'assistant')} />
      {/* Share the assistant text gutter (space-3 mobile / space-8 @lg), and no
          inner inset — the dot and label sit flush at that gutter, on the leading
          edge of assistant prose. */}
      <div className="assistant-msg-row">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-[hundredfold-pulse_1.4s_infinite] shrink-0" />
          <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-[var(--weight-medium)]">
            Thinking
          </span>
        </div>
      </div>
    </div>
  )
}
