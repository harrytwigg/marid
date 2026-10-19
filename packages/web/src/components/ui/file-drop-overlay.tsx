/* The full-surface "drop it here" state, shared by every surface that accepts a
 * file drag: chat's pane and the Todo detail view. One overlay so a drop reads
 * the same wherever the operator lets go of the file. */

export function FileDropOverlay() {
  return (
    <div
      data-testid="file-drop-overlay"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'color-mix(in srgb, var(--bg) 85%, transparent)',
        transition: 'opacity 150ms ease-in-out',
      }}
    >
      <div
        style={{
          border: '2px dashed var(--accent)',
          borderRadius: 'var(--radius-lg)',
          padding: '48px 64px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-body)' }}>
          Drop files here
        </span>
      </div>
    </div>
  )
}
