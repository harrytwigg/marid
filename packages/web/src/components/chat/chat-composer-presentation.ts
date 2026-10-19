import type { CSSProperties } from 'react'

export function composerCardPresentation(isActive: boolean, loading: boolean): {
  className: string
  style: CSSProperties | undefined
} {
  const className = `composer-card ${isActive ? 'composer-card-active bg-[var(--bg-secondary)]' : 'bg-[var(--fill-tertiary)]'}${isActive && loading ? ' composer-card-loading' : ''} rounded-[22px] px-[var(--space-4)] pt-[var(--space-3)] pb-[var(--space-2)] transition-[background-color,box-shadow] duration-200 ease-in-out`
  return { className, style: undefined }
}
