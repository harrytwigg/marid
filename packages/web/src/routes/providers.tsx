
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { THEMES, type ThemeId } from '@/lib/themes'

interface ThemeContextValue {
  theme: ThemeId
  setTheme: (t: ThemeId) => void
}

const ThemeContext = createContext<ThemeContextValue>({ theme: 'dark', setTheme: () => {} })

/**
 * An installed PWA paints its titlebar from these metas. index.html declares one
 * per colour scheme, which is only the state before this script runs: an
 * explicitly light install on a dark OS must not keep the dark one, so every
 * meta takes the theme the app actually resolved. Read back off --bg so
 * the titlebar and the page can never disagree about what the background is.
 */
function syncThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  if (!bg) return
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', bg)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>('dark')

  const apply = useCallback((t: ThemeId) => {
    setThemeState(t)
    localStorage.setItem('jinn-theme', t)
    const el = document.documentElement
    el.removeAttribute('data-theme')
    if (t === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      el.setAttribute('data-theme', prefersDark ? 'dark' : 'light')
    } else {
      el.setAttribute('data-theme', t)
    }
    syncThemeColor()
  }, [])

  useEffect(() => {
    const saved = localStorage.getItem('jinn-theme')
    // Coerce stale ids from removed themes (glass/atelier/…) to a valid one.
    const valid = saved && THEMES.some((t) => t.id === saved) ? (saved as ThemeId) : 'dark'
    apply(valid)
  }, [apply])

  // React to OS color scheme changes when theme is "system"
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    function handleChange() {
      const current = localStorage.getItem('jinn-theme') as ThemeId | null
      if (current === 'system') {
        const el = document.documentElement
        el.setAttribute('data-theme', mq.matches ? 'dark' : 'light')
        syncThemeColor()
      }
    }
    mq.addEventListener('change', handleChange)
    return () => mq.removeEventListener('change', handleChange)
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, setTheme: apply }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
