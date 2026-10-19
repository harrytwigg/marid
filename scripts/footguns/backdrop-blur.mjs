// The raw-backdrop-blur rule, in its own module so check-footguns.mjs does not grow.
import { BACKDROP_BLUR_ALLOWLIST, GLASS_TOKEN_FILE } from "./backdrop-blur-allowlist.mjs"

export const BACKDROP_BLUR_PATTERN =
  /backdrop-filter|backdropFilter|\bbackdrop-(?:blur|saturate|brightness|contrast|grayscale|hue-rotate|invert|sepia)\b/

export const RAW_BACKDROP_BLUR = {
  name: "raw-backdrop-blur",
  message:
    "a raw backdrop filter in the web app — blur is the costliest thing the compositor does here, and the budget (3 blurred surfaces on screen, 32px, never on rows or cards inside a scroller, never animated) and the coarse-pointer and reduced-transparency fallbacks only hold if every blur goes through the glass classes",
  fix: "Use .glass-float or .glass-float-bar from routes/glass-identity.css (or .glass-tint where nothing moves behind the surface). A file that cannot move yet goes in scripts/footguns/backdrop-blur-allowlist.mjs with a one-line reason.",
  allow: new Set([GLASS_TOKEN_FILE, ...BACKDROP_BLUR_ALLOWLIST.keys()]),
  scans: (relPath) =>
    relPath.startsWith("packages/web/src/") && /\.(?:tsx?|css)$/.test(relPath) && !/\/__tests__\/|\.test\./.test(relPath),
  find: (text) => {
    const found = []
    text.split("\n").forEach((line, index) => {
      if (BACKDROP_BLUR_PATTERN.test(line)) found.push(index + 1)
    })
    return found
  },
}
