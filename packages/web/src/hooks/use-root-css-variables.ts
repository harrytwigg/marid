import { useEffect } from 'react'
import { type JinnSettings, hexToAccentFill, hexToContrastText } from '@/lib/settings'

/** Publishes the settings the stylesheet reads as custom properties on <html>.
 *  They are set inline so they beat the :root defaults in globals.css, and
 *  --text-scale is the same property the blocking bootstrap in index.html sets
 *  before first paint — this is what keeps it in step once React takes over.
 *  data-transparency is the same story: an attribute the stylesheet keys on,
 *  written by the bootstrap first and kept here. */
export function useRootCssVariables(settings: JinnSettings): void {
  useEffect(() => {
    const el = document.documentElement.style
    if (settings.accentColor) {
      el.setProperty('--accent', settings.accentColor)
      el.setProperty('--accent-fill', hexToAccentFill(settings.accentColor))
      el.setProperty('--accent-contrast', hexToContrastText(settings.accentColor))
    } else {
      el.removeProperty('--accent')
      el.removeProperty('--accent-fill')
      el.removeProperty('--accent-contrast')
    }
  }, [settings.accentColor])

  useEffect(() => {
    document.documentElement.style.setProperty('--text-scale', String(settings.textScale))
  }, [settings.textScale])

  useEffect(() => {
    const root = document.documentElement
    if (settings.transparency === 'reduced') root.setAttribute('data-transparency', 'reduced')
    else root.removeAttribute('data-transparency')
  }, [settings.transparency])
}
