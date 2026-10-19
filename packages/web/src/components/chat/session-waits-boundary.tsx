import { Component, type ErrorInfo, type ReactNode } from 'react'

/** One line of the popup where there are no rows: loading, empty, failed. */
export function WaitsNote({ children }: { children: ReactNode }) {
  return <p className="m-0 px-3 py-3 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">{children}</p>
}

/** The popup's code is its own chunk, so a chunk gone stale after a deploy fails here, in the popup,
 *  and the chat around it stays up. The boundary starts clean on each open, but `lazy` keeps a
 *  rejected import, so the popup reads as failed until the page is reloaded. */
export class SessionWaitsBoundary extends Component<{ children: ReactNode; failure?: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[SessionWaits]', error.message, '\nComponent stack:', info.componentStack)
  }
  override render() {
    if (!this.state.failed) return this.props.children
    return this.props.failure ?? <WaitsNote>Could not load what this session is waiting on.</WaitsNote>
  }
}
