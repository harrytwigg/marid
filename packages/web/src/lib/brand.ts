/** The product name users see. "Jinn" stays the internal codename (identifiers,
 *  env vars, paths); only user-visible strings read from here. */
export const PRODUCT_NAME = "Marid"

/** The default brand mark: the glass tile for the rail and onboarding, the lead
 *  delta alone as the tab icon (it holds up at 16px), and a PNG of that for
 *  browsers that skip SVG favicons. The artwork carries no letters. */
export const BRAND_MARK_SRC = "/icons/marid-mark.svg"
export const BRAND_FAVICON_SVG = "/icons/marid-favicon.svg"
export const BRAND_FAVICON_PNG = "/icons/favicon-32.png"

/** The mark an operator chose in Branding, if any. It wins everywhere the
 *  default mark would be drawn: portalEmoji first, then the older portalIcon. */
export function customBrandGlyph(settings: { portalEmoji: string | null; portalIcon: string | null }): string | null {
  return settings.portalEmoji?.trim() || settings.portalIcon?.trim() || null
}
