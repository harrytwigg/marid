// Where a raw backdrop filter may live besides the glass token file. The token
// file owns the material: a surface blurs through .glass-float, .glass-float-bar,
// .glass-overlay or the composer rules there, so the radius, the pointer fallback
// and reduced transparency are decided once. A surface that must not blur uses
// the tints (.glass-tint, or a --glass-* token as its background).
//
// The list is empty and should stay empty. A file that truly cannot move goes
// here with a one-line reason; the test fails on an entry whose file no longer
// filters.
export const GLASS_TOKEN_FILE = "packages/web/src/routes/glass-identity.css"

/** @type {ReadonlyMap<string, string>} */
export const BACKDROP_BLUR_ALLOWLIST = new Map([])
