import { useState, type ReactNode } from 'react'
import { copyText } from '@/platform'
import './code-block-chrome.css'

export function CodeBlockChrome({
  children,
  code,
  language,
  className,
}: {
  children: ReactNode
  code: string
  language?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    void copyText(code).then((result) => {
      if (result.status === 'performed') {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }
    })
  }

  return (
    <div className={`code-block-wrap ${className ?? ''} rounded-[var(--radius-lg)] overflow-hidden`}>
      <div className="flex items-center justify-between gap-[var(--space-2)] py-[3px] pl-[var(--space-3)] pr-[var(--space-1)]" data-code-head>
        <span className="text-[length:var(--text-caption2)] tracking-wide text-[var(--text-tertiary)] font-[family-name:var(--font-code)]">
          {language || 'text'}
        </span>
        <button
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy'}
          className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-[7px] border-none bg-transparent text-[var(--text-quaternary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer"
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </div>
      {children}
    </div>
  )
}
