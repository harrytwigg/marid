import type { ButtonHTMLAttributes } from 'react'

export function QuietCard({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={`glass-card rounded-[var(--radius-xl)] border-none transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)] active:scale-[0.99] ${className}`}
    />
  )
}
