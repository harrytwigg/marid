import { LEGACY_PORTAL_NAME } from "@hundredfold/legacy-names"

/** The product name users see. Names the app builds for itself (storage keys, headers, the
 *  plugin SDK specifier) come from the codename instead (codename.ts); only user-visible strings read from here. */
export const PRODUCT_NAME = "Hundredfold"

/** What the server files the portal (COO) under when `portal.portalName` is unset: the internal
 *  slug of the org root, and the prefix older session titles carry. It never changes with the product name. */
export { LEGACY_PORTAL_NAME }

/** The default brand mark: the glass tile for the rail and onboarding. The tab
 *  icon (the lead delta alone, which holds up at 16px, plus a PNG for browsers
 *  that skip SVG favicons) is declared in index.html. The artwork carries no
 *  letters; hundredfold-mark-mono.svg is the single-colour form for contexts that
 *  tint the mark (none draw it yet). */
export const BRAND_MARK_SRC = "/icons/hundredfold-mark.svg"

/** The mark an operator chose in Branding, if any. It wins everywhere the
 *  default mark would be drawn, the tab icon included. */
export function customBrandGlyph(settings: { portalEmoji: string | null }): string | null {
  return settings.portalEmoji?.trim() || null
}
