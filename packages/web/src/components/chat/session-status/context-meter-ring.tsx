import { cn } from '@/lib/utils'

const SIZE = 18
const STROKE = 2.5
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

interface ContextMeterRingProps {
  /** Fraction filled in [0,1]; null draws the dashed "unknown" ring. */
  fraction: number | null
  /** Threshold colour (a CSS variable reference); neutral when omitted. */
  color?: string
  pulsing?: boolean
}

/** The ~18px ring: a track, an arc for the fill, dashed and empty when unknown. */
export function ContextMeterRing({ fraction, color, pulsing }: ContextMeterRingProps) {
  const unknown = fraction == null
  const filled = unknown ? 0 : Math.max(fraction, 0.02) * CIRCUMFERENCE
  return (
    <svg
      aria-hidden
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      data-testid="context-meter-ring"
      data-unknown={unknown || undefined}
      className={cn('shrink-0 -rotate-90', pulsing && 'motion-safe:animate-pulse')}
    >
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke={unknown ? 'var(--text-quaternary)' : 'var(--fill-secondary)'}
        strokeWidth={STROKE}
        strokeDasharray={unknown ? '2 2.6' : undefined}
      />
      {!unknown && (
        <circle
          data-testid="context-meter-arc"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke={color ?? 'var(--text-tertiary)'}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
        />
      )}
    </svg>
  )
}
