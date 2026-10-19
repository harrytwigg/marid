import { useState } from 'react'
import { fallbackLinkLabel, type FallbackHop, type FallbackHopNoticeMeta, type FallbackHopReason } from '@jinn/fallback-chain-wire'
import { ArrowRightLeftIcon, ChevronDown, ChevronRight } from '@/components/ui/icon'
import { SKIP_REASON_TEXT, formatReset } from '@/lib/fallback-format'
import type { Message } from '@/lib/conversations'

/**
 * A fallback hop in the transcript: the gateway writes a notification whose
 * `meta.fallbackHop` is the hop, and it reads as a compact card rather than a bell
 * banner. A notification without one renders as it always did.
 */

const REASON_TEXT: Record<FallbackHopReason, string> = {
  'rate-limit': 'usage limit',
  quota: 'quota used up',
  'retry-exhausted': 'provider retries ran out',
  'invalid-model': 'model not served',
  auth: 'profile signed out',
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** The hop a notification carries, or null when it carries none or a malformed one. */
export function parseFallbackHop(message: Message): FallbackHop | null {
  if (message.role !== 'notification') return null
  const hop = (message.meta as Partial<FallbackHopNoticeMeta> | undefined)?.fallbackHop as Partial<FallbackHop> | undefined
  if (!hop || typeof hop !== 'object') return null
  if (!text(hop.from) || !text(hop.fromLabel) || !text(hop.reason)) return null
  return hop as FallbackHop
}

/** A link key (`engine|profile|model`) as the label a row would carry. */
export function labelOfLinkKey(key: string): string {
  const [engine = '', profile = '', model = ''] = key.split('|')
  return fallbackLinkLabel({ engine, ...(profile ? { profile } : {}), ...(model ? { model } : {}) })
}

/** "Fell back from A to B: usage limit, resets 16:00", or the chain running out. */
export function hopSentence(hop: FallbackHop): string {
  const reset = formatReset(hop.resetsAt)
  const why = `${REASON_TEXT[hop.reason] ?? hop.reason}${reset ? `, resets ${reset}` : ''}`
  if (hop.to === null || !hop.toLabel) return `Fallback chain ran out from ${hop.fromLabel}: ${why}. Waiting for it to reset.`
  return `Fell back from ${hop.fromLabel} to ${hop.toLabel}: ${why}`
}

/** The links passed over on the way, each with why. */
function PassedOver({ skipped }: { skipped: NonNullable<FallbackHop['skipped']> }) {
  return (
    <ul data-fallback-hop-skipped className="m-0 mt-[var(--space-1)] list-none p-0">
      {skipped.map((link) => (
        <li key={link.key} className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
          Passed over {labelOfLinkKey(link.key)}: {SKIP_REASON_TEXT[link.reason] ?? link.reason}
        </li>
      ))}
    </ul>
  )
}

export function FallbackHopCard({ hop }: { hop: FallbackHop }) {
  const [open, setOpen] = useState(false)
  const skipped = hop.skipped ?? []
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className="flex justify-center px-[var(--space-4)] mb-[var(--space-1)]">
      <div
        data-fallback-hop={hop.to === null ? 'ran-out' : 'moved'}
        className="flex max-w-[85%] items-start gap-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--fill-secondary)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-caption1)] leading-[var(--leading-relaxed)] text-[var(--text-secondary)]"
      >
        <ArrowRightLeftIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[var(--text-tertiary)]" />
        <div className="min-w-0">
          <span className="[overflow-wrap:anywhere]">{hopSentence(hop)}</span>
          {skipped.length > 0 && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="ml-[var(--space-1)] inline-flex min-h-[24px] cursor-pointer items-center gap-[2px] border-none bg-transparent p-0 text-[length:var(--text-caption2)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            >
              <Chevron size={11} aria-hidden />
              {skipped.length === 1 ? '1 passed over' : `${skipped.length} passed over`}
            </button>
          )}
          {open && skipped.length > 0 && <PassedOver skipped={skipped} />}
        </div>
      </div>
    </div>
  )
}
