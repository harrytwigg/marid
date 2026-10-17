import type { CSSProperties } from 'react'

export function composerCardPresentation(isActive: boolean, loading: boolean): {
  className: string
  style: CSSProperties | undefined
} {
  const className = `composer-card ${isActive ? 'composer-card-active bg-[var(--bg-secondary)]' : 'bg-[var(--fill-tertiary)]'} rounded-[22px] px-[var(--space-4)] pt-[var(--space-3)] pb-[var(--space-2)] transition-[background-color,box-shadow] duration-200 ease-in-out`
  if (!isActive) return { className, style: undefined }
  const style = loading
    ? { boxShadow: 'var(--shadow-card), 0 0 0 1.5px color-mix(in srgb, var(--accent) 38%, transparent)' }
    : undefined
  return { className, style }
}
