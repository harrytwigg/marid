import { ContextMeter, type ContextMeterProps } from './context-meter'

/**
 * The session's status items in the composer toolbar, right after the model
 * chip: a plain flex row, so another chip can join the meter without a layout
 * change.
 */
export function SessionStatusCluster(props: ContextMeterProps) {
  return (
    <div data-testid="session-status-cluster" className="flex items-center gap-1 empty:hidden">
      <ContextMeter {...props} />
    </div>
  )
}
