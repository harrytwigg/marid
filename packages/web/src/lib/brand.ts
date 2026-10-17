/** The product name users see. "Jinn" stays the internal codename (identifiers,
 *  env vars, paths); only user-visible strings read from here. */
export const PRODUCT_NAME = "Marid"

/** The default brand mark: the glass tile for the rail and onboarding. The tab
 *  icon (the lead delta alone, which holds up at 16px, plus a PNG for browsers
 *  that skip SVG favicons) is declared in index.html. The artwork carries no
 *  letters; marid-mark-mono.svg is the single-colour form for contexts that
 *  tint the mark (none draw it yet). */
export const BRAND_MARK_SRC = "/icons/marid-mark.svg"

/** The mark an operator chose in Branding, if any. It wins everywhere the
 *  default mark would be drawn, the tab icon included. */
export function customBrandGlyph(settings: { portalEmoji: string | null }): string | null {
  return settings.portalEmoji?.trim() || null
}
