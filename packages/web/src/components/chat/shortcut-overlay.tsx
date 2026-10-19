
import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from '@/components/ui/icon'
import type { ShortcutDef } from '@/hooks/use-keyboard-shortcuts'
import { SHORTCUT_CATEGORY_ORDER, formatShortcutKeys } from '@/lib/shortcut-catalog'

interface ShortcutOverlayProps {
  shortcuts: ShortcutDef[]
  onClose: () => void
}

export function ShortcutOverlay({ shortcuts, onClose }: ShortcutOverlayProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [isClosing, setIsClosing] = useState(false)

  const handleClose = useCallback(() => {
    setIsClosing(true)
    setTimeout(() => onClose(), 150)
  }, [onClose])

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        handleClose()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [handleClose])

  const enabled = shortcuts.filter(s => s.enabled !== false)
  const grouped = SHORTCUT_CATEGORY_ORDER
    .map(cat => ({
      category: cat,
      items: enabled.filter(s => s.category === cat),
    }))
    .filter(g => g.items.length > 0)

  return (
    <div
      ref={ref}
      role="complementary"
      aria-label="Keyboard shortcuts"
      className={`fixed bottom-4 right-4 z-40 w-[280px] overflow-hidden rounded-[var(--radius-lg)] border border-border glass-overlay transition-opacity duration-150 ${isClosing ? 'opacity-0' : 'animate-fade-in'}`}
    >
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <span className="text-subheadline font-semibold text-foreground">Keyboard Shortcuts</span>
        <button
          onClick={handleClose}
          className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Close"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="px-3 py-2 max-h-[60vh] overflow-y-auto">
        {grouped.map((group, gi) => (
          <div key={group.category} className={gi > 0 ? 'mt-3' : ''}>
            <div className="mb-1.5 text-caption2 font-medium uppercase tracking-wider text-muted-foreground">
              {group.category}
            </div>
            <div className="space-y-1">
              {group.items.map(s => (
                <div key={s.key + (s.modifiers?.join('') ?? '')} className="flex items-center gap-2 py-0.5">
                  <kbd className="inline-flex min-w-[24px] items-center justify-center rounded-[var(--radius-sm)] bg-[var(--fill-tertiary)] px-1.5 py-0.5 font-mono text-caption1 font-medium text-foreground">
                    {formatShortcutKeys(s)}
                  </kbd>
                  <span className="text-caption1 text-muted-foreground">{s.description}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
